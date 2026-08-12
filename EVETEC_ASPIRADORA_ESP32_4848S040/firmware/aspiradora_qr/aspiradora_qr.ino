#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Touch_GT911.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <evetec_qrcode.h>
#include <time.h>

// ESP32-4848S040 (N16R8) - salida relay1 del conector H1.
constexpr int PIN_RELAY = 40;
constexpr int RELAY_ACTIVE_LEVEL = HIGH;
constexpr int PIN_BACKLIGHT = 38;
constexpr int TOUCH_SDA = 19;
constexpr int TOUCH_SCL = 45;

// Se conserva el ID productivo existente; toda la experiencia visible es de inflador.
const char *DEVICE_ID = "ASPIRADORA_BASIC_001";
const char *API_BASE = "https://evetec-api.onrender.com";
const char *DEVICE_API_KEY = ""; // Debe coincidir con DEVICE_API_KEY del servidor.

constexpr uint32_t PAYMENT_POLL_MS = 2500;
constexpr uint32_t PAYMENT_TIMEOUT_MS = 10UL * 60UL * 1000UL;
constexpr uint32_t CONFIG_REFRESH_MS = 30000;
constexpr uint32_t WIFI_RETRY_MS = 15000;

constexpr uint16_t C_BG = 0x0841;
constexpr uint16_t C_PANEL = 0x10A3;
constexpr uint16_t C_PANEL_2 = 0x18E5;
constexpr uint16_t C_WHITE = 0xFFFF;
constexpr uint16_t C_MUTED = 0x9CF3;
constexpr uint16_t C_CYAN = 0x06FF;
constexpr uint16_t C_GREEN = 0x4EEA;
constexpr uint16_t C_RED = 0xF9E8;
constexpr uint16_t C_GOLD = 0xFDC0;
constexpr uint16_t C_BLACK = 0x0000;

const char GLOBALSIGN_R4_ROOT_CA[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIB3DCCAYOgAwIBAgINAgPlfvU/k/2lCSGypjAKBggqhkjOPQQDAjBQMSQwIgYDVQQLExtHbG9i
YWxTaWduIEVDQyBSb290IENBIC0gUjQxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkds
b2JhbFNpZ24wHhcNMTIxMTEzMDAwMDAwWhcNMzgwMTE5MDMxNDA3WjBQMSQwIgYDVQQLExtHbG9i
YWxTaWduIEVDQyBSb290IENBIC0gUjQxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkds
b2JhbFNpZ24wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAS4xnnTj2wlDp8uORkcA6SumuU5BwkW
ymOxuYb4ilfBV85C+nOh92VC/x7BALJucw7/xyHlGKSq2XE/qNS5zowdo0IwQDAOBgNVHQ8BAf8E
BAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUVLB7rUW44kB/+wpu+74zyTyjhNUwCgYI
KoZIzj0EAwIDRwAwRAIgIk90crlgr/HmnKAWBVBfw147bmF0774BxL4YSFlhgjICICadVGNA3jdg
UM/I2O2dgq43mLyjj0xMqTQrbO/7lZsm
-----END CERTIFICATE-----
)EOF";

Arduino_ESP32RGBPanel *rgbBus = new Arduino_ESP32RGBPanel(
    39, 48, 47, 18, 17, 16, 21,
    11, 12, 13, 14, 0, 8, 20, 3, 46, 9, 10, 4, 5, 6, 7, 15);

Arduino_ST7701_RGBPanel *display = new Arduino_ST7701_RGBPanel(
    rgbBus, GFX_NOT_DEFINED, 0, true, 480, 480,
    st7701_type1_init_operations, sizeof(st7701_type1_init_operations), true,
    10, 8, 50, 10, 8, 20);

Touch_GT911 touch(TOUCH_SDA, TOUCH_SCL, -1, -1, 480, 480);
Preferences preferences;
WebServer portal(80);

enum UiState {
  UI_BOOT,
  UI_WIFI_SETUP,
  UI_IDLE,
  UI_CREATING_PAYMENT,
  UI_WAITING_PAYMENT,
  UI_OWNER_LINK,
  UI_PREPARING,
  UI_RUNNING,
  UI_RELAY_TEST,
  UI_THANKS,
  UI_ERROR
};

UiState uiState = UI_BOOT;
String wifiSsid;
String wifiPassword;
String paymentId;
String paymentLink;
String ownerLink;
String lastError;
float servicePrice = 10.0f;
uint32_t serviceSeconds = 240;
uint32_t prestartSeconds = 15;
uint32_t relayTestSeconds = 3;
uint32_t pendingServiceSeconds = 240;
bool serviceActive = true;
bool ownerLinked = false;
bool touchWasDown = false;
bool portalActive = false;
bool portalReconnectPending = false;
uint32_t paymentStartedAt = 0;
uint32_t lastPaymentPollAt = 0;
uint32_t relayEndsAt = 0;
uint32_t prestartEndsAt = 0;
uint32_t relayTestEndsAt = 0;
uint32_t thanksEndsAt = 0;
uint32_t lastCountdownSecond = UINT32_MAX;
uint32_t lastConfigRefreshAt = 0;
uint32_t lastWifiRetryAt = 0;
uint32_t lastAnimationAt = 0;
uint8_t animationPhase = 0;

void relayOff() {
  digitalWrite(PIN_RELAY, RELAY_ACTIVE_LEVEL == HIGH ? LOW : HIGH);
}

void relayOn() {
  digitalWrite(PIN_RELAY, RELAY_ACTIVE_LEVEL);
}

void textAt(const String &text, int x, int y, uint8_t size, uint16_t color) {
  display->setTextWrap(false);
  display->setTextSize(size);
  display->setTextColor(color);
  display->setCursor(x, y);
  display->print(text);
}

void centerText(const String &text, int y, uint8_t size, uint16_t color) {
  int16_t x1, y1;
  uint16_t w, h;
  display->setTextSize(size);
  display->getTextBounds(text, 0, y, &x1, &y1, &w, &h);
  textAt(text, max(0, (480 - static_cast<int>(w)) / 2), y, size, color);
}

void button(int x, int y, int w, int h, uint16_t color, const String &label,
            uint16_t textColor = C_BG, uint8_t textSize = 3) {
  display->fillRoundRect(x, y, w, h, 18, color);
  int16_t x1, y1;
  uint16_t tw, th;
  display->setTextSize(textSize);
  display->getTextBounds(label, 0, 0, &x1, &y1, &tw, &th);
  textAt(label, x + (w - static_cast<int>(tw)) / 2,
         y + (h - static_cast<int>(th)) / 2, textSize, textColor);
}

void header(const String &status, uint16_t color = C_CYAN) {
  textAt("EVETEC", 24, 20, 2, C_WHITE);
  display->fillCircle(452, 27, 6, WiFi.status() == WL_CONNECTED ? C_GREEN : C_RED);
  textAt(status, 24, 50, 1, color);
  display->drawFastHLine(24, 72, 432, C_PANEL_2);
}

String moneyText(float amount) {
  if (fabs(amount - roundf(amount)) < 0.001f) return "$" + String(static_cast<int>(roundf(amount)));
  return "$" + String(amount, 2);
}

String durationText(uint32_t seconds) {
  uint32_t minutes = seconds / 60;
  uint32_t rest = seconds % 60;
  if (rest == 0) return String(minutes) + (minutes == 1 ? " minuto" : " minutos");
  return String(minutes) + "m " + String(rest) + "s";
}

void clearScreen() {
  display->fillScreen(C_BG);
}

void drawTire(int cx, int cy, int radius, uint8_t phase, uint16_t accent = C_CYAN) {
  display->fillCircle(cx, cy, radius + 5, C_BG);
  display->fillCircle(cx, cy, radius, C_BLACK);
  display->drawCircle(cx, cy, radius, C_MUTED);
  display->drawCircle(cx, cy, radius - 5, C_PANEL_2);
  display->fillCircle(cx, cy, radius - 20, C_PANEL);
  display->drawCircle(cx, cy, radius - 20, accent);
  display->fillCircle(cx, cy, 10, accent);

  for (int i = 0; i < 6; i++) {
    const float angle = (i * 60 + phase * 12) * DEG_TO_RAD;
    const int x1 = cx + cosf(angle) * 14;
    const int y1 = cy + sinf(angle) * 14;
    const int x2 = cx + cosf(angle) * (radius - 24);
    const int y2 = cy + sinf(angle) * (radius - 24);
    display->drawLine(x1, y1, x2, y2, C_WHITE);
  }

  for (int i = 0; i < 8; i++) {
    const float angle = (i * 45 + 8) * DEG_TO_RAD;
    const int tx = cx + cosf(angle) * (radius - 2);
    const int ty = cy + sinf(angle) * (radius - 2);
    display->fillCircle(tx, ty, 2, C_MUTED);
  }
}

void drawAirPulse(uint8_t phase) {
  display->fillRect(25, 330, 430, 48, C_BG);
  display->drawLine(55, 356, 405, 356, C_PANEL_2);
  for (int i = 0; i < 5; i++) {
    const int x = 70 + ((phase * 22 + i * 78) % 330);
    const int y = 348 - (i % 2) * 10;
    display->fillCircle(x, y, 4 + (i % 2), i == 4 ? C_GREEN : C_CYAN);
  }
  display->fillTriangle(405, 347, 405, 365, 430, 356, C_GREEN);
}

void showBoot(const String &message) {
  uiState = UI_BOOT;
  clearScreen();
  centerText("EVETEC", 110, 5, C_CYAN);
  centerText("INFLADOR QR", 180, 3, C_WHITE);
  centerText(message, 280, 2, C_MUTED);
}

void showError(const String &title, const String &message) {
  relayOff();
  uiState = UI_ERROR;
  lastError = message;
  clearScreen();
  header("ERROR", C_RED);
  centerText(title, 125, 4, C_RED);
  centerText(message.substring(0, 34), 205, 2, C_WHITE);
  centerText(message.substring(34, 68), 240, 2, C_WHITE);
  button(70, 345, 340, 70, C_CYAN, "VOLVER", C_BG, 3);
}

void showIdle() {
  relayOff();
  uiState = UI_IDLE;
  paymentId = "";
  paymentLink = "";
  clearScreen();
  header(serviceActive ? "LISTO PARA USAR" : "FUERA DE SERVICIO",
         serviceActive ? C_GREEN : C_RED);
  centerText("INFLADOR DE NEUMATICOS", 88, 2, C_WHITE);
  drawTire(105, 190, 62, animationPhase);
  textAt("TIEMPO", 215, 135, 1, C_MUTED);
  textAt(durationText(serviceSeconds), 215, 158, 2, C_CYAN);
  textAt("PRECIO", 215, 205, 1, C_MUTED);
  textAt(moneyText(servicePrice), 215, 225, 5, C_GOLD);

  if (!ownerLinked && WiFi.status() == WL_CONNECTED) {
    centerText("Primero vincula la cuenta que cobrara", 278, 1, C_MUTED);
    button(42, 300, 396, 76, C_CYAN, "VINCULAR CUENTA", C_BG, 3);
  } else if (serviceActive && WiFi.status() == WL_CONNECTED) {
    button(42, 300, 396, 76, C_GREEN, "INFLAR NEUMATICOS", C_BG, 3);
  } else {
    button(42, 300, 396, 76, C_PANEL_2, "NO DISPONIBLE", C_MUTED, 2);
  }

  textAt(ownerLinked ? "MP VINCULADO" : "SIN CUENTA MP", 28, 425, 1,
         ownerLinked ? C_GREEN : C_GOLD);
  button(290, 406, 162, 48, C_PANEL_2, "PROBAR RELE", C_WHITE, 1);
  animationPhase++;
}

bool drawQr(const String &data, int centerX, int centerY, int maxPixels) {
  if (data.isEmpty()) return false;

  QRCode qr;
  uint8_t *buffer = nullptr;
  bool generated = false;

  for (uint8_t version = 10; version <= 20; version++) {
    uint16_t bytes = qrcode_getBufferSize(version);
    buffer = static_cast<uint8_t *>(malloc(bytes));
    if (!buffer) return false;
    if (qrcode_initText(&qr, buffer, version, ECC_MEDIUM, data.c_str()) == 0) {
      generated = true;
      break;
    }
    free(buffer);
    buffer = nullptr;
  }

  if (!generated || !buffer) return false;
  int scale = max(2, maxPixels / (qr.size + 8));
  int total = (qr.size + 8) * scale;
  int left = centerX - total / 2;
  int top = centerY - total / 2;
  display->fillRect(left, top, total, total, C_WHITE);
  for (uint8_t y = 0; y < qr.size; y++) {
    for (uint8_t x = 0; x < qr.size; x++) {
      if (qrcode_getModule(&qr, x, y)) {
        display->fillRect(left + (x + 4) * scale, top + (y + 4) * scale,
                          scale, scale, C_BLACK);
      }
    }
  }
  free(buffer);
  return true;
}

void showPaymentQr() {
  uiState = UI_WAITING_PAYMENT;
  clearScreen();
  header("ESPERANDO PAGO", C_GOLD);
  centerText("Escanea con Mercado Pago", 86, 2, C_WHITE);
  if (!drawQr(paymentLink, 240, 270, 330)) {
    showError("QR NO DISPONIBLE", "El enlace de pago es demasiado largo");
    return;
  }
  centerText(moneyText(servicePrice) + " - " + durationText(serviceSeconds), 438, 2, C_CYAN);
}

void drawCountdown(uint32_t remaining) {
  display->fillRect(45, 190, 390, 130, C_BG);
  char value[12];
  snprintf(value, sizeof(value), "%02lu:%02lu",
           static_cast<unsigned long>(remaining / 60),
           static_cast<unsigned long>(remaining % 60));
  centerText(value, 210, 7, C_WHITE);
}

void drawPrestartCountdown(uint32_t remaining) {
  display->fillRect(155, 238, 170, 64, C_BG);
  centerText(String(remaining), 242, 6, C_GOLD);
}

void startService(uint32_t seconds) {
  serviceSeconds = max<uint32_t>(1, min<uint32_t>(seconds, 3600));
  relayOn();
  relayEndsAt = millis() + serviceSeconds * 1000UL;
  lastCountdownSecond = UINT32_MAX;
  uiState = UI_RUNNING;
  clearScreen();
  header("INFLADOR ACTIVO", C_GREEN);
  centerText("INFLANDO NEUMATICOS", 112, 3, C_GREEN);
  centerText("Tiempo restante", 170, 2, C_MUTED);
  drawCountdown(serviceSeconds);
  drawAirPulse(animationPhase++);
  centerText("Se apaga automaticamente", 385, 1, C_MUTED);
  button(150, 414, 180, 42, C_RED, "DETENER", C_WHITE, 1);
}

void startPreparation(uint32_t seconds) {
  pendingServiceSeconds = max<uint32_t>(1, min<uint32_t>(seconds, 3600));
  if (prestartSeconds == 0) {
    startService(pendingServiceSeconds);
    return;
  }

  relayOff();
  prestartEndsAt = millis() + prestartSeconds * 1000UL;
  lastCountdownSecond = UINT32_MAX;
  uiState = UI_PREPARING;
  clearScreen();
  header("PAGO APROBADO", C_GREEN);
  centerText("LISTO PARA USAR", 100, 4, C_GREEN);
  centerText("Prepare la manguera", 160, 2, C_WHITE);
  centerText("El inflador inicia en", 205, 2, C_MUTED);
  drawPrestartCountdown(prestartSeconds);
  drawTire(240, 350, 46, animationPhase, C_GREEN);
  button(140, 420, 200, 38, C_GREEN, "INICIAR AHORA", C_BG, 1);
}

void startRelayTest() {
  relayOn();
  relayTestEndsAt = millis() + relayTestSeconds * 1000UL;
  lastCountdownSecond = UINT32_MAX;
  uiState = UI_RELAY_TEST;
  clearScreen();
  header("PRUEBA TECNICA", C_GOLD);
  centerText("RELE GPIO 40 ACTIVO", 115, 3, C_GOLD);
  centerText("Pulso de comprobacion", 175, 2, C_WHITE);
  drawCountdown(relayTestSeconds);
  button(130, 390, 220, 58, C_RED, "APAGAR AHORA", C_WHITE, 2);
}

void showThanks() {
  relayOff();
  uiState = UI_THANKS;
  thanksEndsAt = millis() + 5000;
  clearScreen();
  header("SERVICIO FINALIZADO", C_GREEN);
  centerText("GRACIAS", 145, 6, C_GREEN);
  centerText("por usar EVETEC", 235, 3, C_WHITE);
  centerText("Buen viaje!", 315, 2, C_CYAN);
}

bool timeIsValid() {
  time_t now = time(nullptr);
  return now > 1704067200; // 2024-01-01, necesario para validar TLS.
}

bool syncClock() {
  if (timeIsValid()) return true;
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  uint32_t started = millis();
  while (!timeIsValid() && millis() - started < 12000) {
    delay(100);
  }
  return timeIsValid();
}

bool httpGetJson(const String &path, DynamicJsonDocument &doc, int &httpCode) {
  if (WiFi.status() != WL_CONNECTED || !timeIsValid()) return false;
  WiFiClientSecure client;
  client.setCACert(GLOBALSIGN_R4_ROOT_CA);
  HTTPClient http;
  const String url = String(API_BASE) + path;
  if (!http.begin(client, url)) return false;
  http.setConnectTimeout(8000);
  http.setTimeout(10000);
  if (strlen(DEVICE_API_KEY)) http.addHeader("X-Device-Key", DEVICE_API_KEY);
  httpCode = http.GET();
  if (httpCode <= 0) {
    http.end();
    return false;
  }
  DeserializationError error = deserializeJson(doc, http.getStream());
  http.end();
  return !error;
}

bool httpPostJson(const String &path, const String &body,
                  DynamicJsonDocument &doc, int &httpCode) {
  if (WiFi.status() != WL_CONNECTED || !timeIsValid()) return false;
  WiFiClientSecure client;
  client.setCACert(GLOBALSIGN_R4_ROOT_CA);
  HTTPClient http;
  const String url = String(API_BASE) + path;
  if (!http.begin(client, url)) return false;
  http.setConnectTimeout(8000);
  http.setTimeout(12000);
  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY)) http.addHeader("X-Device-Key", DEVICE_API_KEY);
  httpCode = http.POST(body);
  if (httpCode <= 0) {
    http.end();
    return false;
  }
  DeserializationError error = deserializeJson(doc, http.getStream());
  http.end();
  return !error;
}

bool fetchRemoteConfig(bool redraw = false) {
  DynamicJsonDocument doc(6144);
  int code = 0;
  if (!httpGetJson("/config/" + String(DEVICE_ID), doc, code) || code != 200 || !doc["ok"]) {
    return false;
  }

  serviceActive = doc["activo"] | false;
  servicePrice = doc["monto"] | doc["precio"] | servicePrice;
  serviceSeconds = doc["segundos"] | serviceSeconds;
  prestartSeconds = constrain(static_cast<uint32_t>(doc["preinicio_segundos"] | prestartSeconds), 0UL, 120UL);
  relayTestSeconds = constrain(static_cast<uint32_t>(doc["prueba_rele_segundos"] | relayTestSeconds), 1UL, 10UL);
  ownerLinked = doc["ownerLinked"] | false;
  lastConfigRefreshAt = millis();
  if (redraw && uiState == UI_IDLE) showIdle();
  return true;
}

bool createPayment() {
  uiState = UI_CREATING_PAYMENT;
  clearScreen();
  header("CONECTANDO", C_GOLD);
  centerText("Preparando pago seguro...", 210, 2, C_WHITE);

  DynamicJsonDocument request(256);
  request["device_id"] = DEVICE_ID;
  String body;
  serializeJson(request, body);

  DynamicJsonDocument response(6144);
  int code = 0;
  if (!httpPostJson("/basic/crear-pago", body, response, code) || code != 200 ||
      !(response["ok"] | false)) {
    showError("NO SE PUDO COBRAR", String(response["error"] | "Error de conexion"));
    return false;
  }

  paymentId = String(response["payment_id"] | "");
  paymentLink = String(response["link"] | "");
  servicePrice = response["monto"] | servicePrice;
  serviceSeconds = response["segundos"] | serviceSeconds;
  if (paymentId.length() < 8 || paymentLink.length() < 20) {
    showError("RESPUESTA INVALIDA", "Servidor no devolvio un pago valido");
    return false;
  }

  paymentStartedAt = millis();
  lastPaymentPollAt = 0;
  showPaymentQr();
  return true;
}

void pollPayment() {
  if (paymentId.isEmpty()) return;
  DynamicJsonDocument request(384);
  request["device_id"] = DEVICE_ID;
  request["payment_id"] = paymentId;
  String body;
  serializeJson(request, body);

  DynamicJsonDocument response(2048);
  int code = 0;
  if (!httpPostJson("/device/claim-payment", body, response, code) || code != 200) return;

  const String status = String(response["status"] | "pending");
  if ((response["activate"] | false) && status == "approved") {
    const uint32_t seconds = response["segundos"] | serviceSeconds;
    paymentId = "";
    startPreparation(seconds);
    return;
  }

  if (status == "rejected" || status == "cancelled" || status == "invalid" ||
      status == "expired" || status == "consumed") {
    paymentId = "";
    showError("PAGO NO HABILITADO", status);
  }
}

bool fetchOwnerLink() {
  DynamicJsonDocument doc(4096);
  int code = 0;
  if (!httpGetJson("/oauth/link/" + String(DEVICE_ID), doc, code) || code != 200 ||
      !(doc["ok"] | false)) {
    showError("VINCULACION", String(doc["error"] | "No disponible"));
    return false;
  }

  ownerLink = String(doc["url"] | "");
  if (ownerLink.length() < 20) {
    showError("VINCULACION", "Servidor sin OAuth configurado");
    return false;
  }

  uiState = UI_OWNER_LINK;
  clearScreen();
  header("CONFIGURACION DEL DUENO", C_CYAN);
  centerText("Vincular cuenta Mercado Pago", 86, 2, C_WHITE);
  if (!drawQr(ownerLink, 240, 270, 330)) {
    showError("QR NO DISPONIBLE", "No se pudo generar el QR OAuth");
    return false;
  }
  centerText("Escanea, autoriza y espera", 438, 1, C_MUTED);
  lastPaymentPollAt = millis();
  return true;
}

void pollOwnerStatus() {
  DynamicJsonDocument doc(1024);
  int code = 0;
  if (!httpGetJson("/owner-status/" + String(DEVICE_ID), doc, code) || code != 200) return;
  if (doc["linked"] | false) {
    ownerLinked = true;
    showIdle();
  }
}

void loadWifi() {
  preferences.begin("evetec", true);
  wifiSsid = preferences.getString("ssid", "");
  wifiPassword = preferences.getString("pass", "");
  preferences.end();
}

void saveWifi(const String &ssid, const String &password) {
  preferences.begin("evetec", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", password);
  preferences.end();
}

bool connectWifi(uint32_t timeoutMs = 16000) {
  if (wifiSsid.isEmpty()) return false;
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < timeoutMs) delay(100);
  return WiFi.status() == WL_CONNECTED;
}

String htmlEscape(String value) {
  value.replace("&", "&amp;");
  value.replace("<", "&lt;");
  value.replace(">", "&gt;");
  value.replace("\"", "&quot;");
  value.replace("'", "&#39;");
  return value;
}

void portalHome() {
  int count = WiFi.scanNetworks();
  String html = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<style>body{font-family:Arial;background:#08111f;color:#fff;max-width:520px;margin:auto;padding:24px}"
          "select,input,button{box-sizing:border-box;width:100%;padding:14px;margin:8px 0;border-radius:10px;border:0}"
          "button{background:#22c55e;font-weight:bold}</style><h1>EVETEC Inflador</h1>";
  html += "<p>Selecciona la red Wi-Fi de la estacion.</p><form method='post' action='/save'><select name='ssid'>";
  for (int i = 0; i < count; i++) {
    html += "<option value='" + htmlEscape(WiFi.SSID(i)) + "'>" + htmlEscape(WiFi.SSID(i)) +
            " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }
  html += "</select><input name='pass' type='password' placeholder='Clave Wi-Fi'>"
          "<button>GUARDAR Y CONECTAR</button></form>";
  portal.send(200, "text/html; charset=utf-8", html);
}

void portalSave() {
  const String ssid = portal.arg("ssid");
  const String password = portal.arg("pass");
  if (ssid.isEmpty()) {
    portal.send(400, "text/plain", "Falta seleccionar una red.");
    return;
  }
  wifiSsid = ssid;
  wifiPassword = password;
  saveWifi(wifiSsid, wifiPassword);
  portal.send(200, "text/html; charset=utf-8",
              "<h2>Wi-Fi guardado</h2><p>La pantalla intentara conectarse.</p>");
  portalReconnectPending = true;
}

void showWifiSetupScreen() {
  uiState = UI_WIFI_SETUP;
  clearScreen();
  header("CONFIGURAR WIFI", C_GOLD);
  centerText("1. Conectate a:", 105, 2, C_WHITE);
  centerText("EVETEC-INFLADOR-SETUP", 145, 2, C_CYAN);
  centerText("Clave: 12345678", 185, 2, C_WHITE);
  centerText("2. Abre 192.168.4.1", 235, 2, C_WHITE);
  centerText("desde el navegador", 275, 2, C_MUTED);
  button(105, 360, 270, 64, C_PANEL_2, "PROBAR RELE GPIO 40", C_WHITE, 1);
  centerText("Funciona sin Internet", 440, 1, C_MUTED);
}

void startWifiPortal() {
  relayOff();
  portalActive = true;
  portalReconnectPending = false;
  uiState = UI_WIFI_SETUP;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("EVETEC-INFLADOR-SETUP", "12345678");
  portal.on("/", HTTP_GET, portalHome);
  portal.on("/save", HTTP_POST, portalSave);
  portal.begin();
  showWifiSetupScreen();
}

void handleTouch(int x, int y) {
  if (uiState == UI_IDLE) {
    if (x >= 275 && y >= 395) {
      startRelayTest();
    } else if (y >= 290 && y <= 390 && WiFi.status() == WL_CONNECTED) {
      if (!ownerLinked) {
        fetchOwnerLink();
      } else if (serviceActive) {
        createPayment();
      }
    }
  } else if (uiState == UI_ERROR && y >= 330) {
    fetchRemoteConfig(false);
    showIdle();
  } else if (uiState == UI_PREPARING && y >= 405) {
    startService(pendingServiceSeconds);
  } else if ((uiState == UI_RUNNING && y >= 395) || uiState == UI_RELAY_TEST) {
    relayOff();
    if (portalActive) showWifiSetupScreen();
    else showIdle();
  }
}

void setup() {
  pinMode(PIN_RELAY, OUTPUT);
  relayOff(); // Estado seguro antes de inicializar pantalla, red o API.
  Serial.begin(115200);

  Wire.begin(TOUCH_SDA, TOUCH_SCL);
  touch.begin();
  touch.setRotation(ROTATION_NORMAL);

  display->begin(11000000);
  pinMode(PIN_BACKLIGHT, OUTPUT);
  digitalWrite(PIN_BACKLIGHT, HIGH);
  showBoot("Iniciando...");

  loadWifi();
  if (!connectWifi()) {
    startWifiPortal();
    return;
  }

  showBoot("Sincronizando seguridad TLS...");
  if (!syncClock()) {
    showError("SIN HORA SEGURA", "No se pudo validar HTTPS");
    return;
  }

  fetchRemoteConfig(false);
  showIdle();
}

void loop() {
  if (portalActive) {
    portal.handleClient();

    touch.read();
    const bool touched = touch.isTouched;
    if (touched && !touchWasDown) {
      const int x = constrain(map(touch.points[0].x, 480, 0, 0, 479), 0, 479);
      const int y = constrain(map(touch.points[0].y, 480, 0, 0, 479), 0, 479);
      if (uiState == UI_WIFI_SETUP && y >= 340) startRelayTest();
      else if (uiState == UI_RELAY_TEST) handleTouch(x, y);
    }
    touchWasDown = touched;

    if (uiState == UI_RELAY_TEST) {
      const uint32_t now = millis();
      if (static_cast<int32_t>(now - relayTestEndsAt) >= 0) {
        relayOff();
        showWifiSetupScreen();
      } else {
        const uint32_t remaining = (relayTestEndsAt - now + 999) / 1000;
        if (remaining != lastCountdownSecond) {
          lastCountdownSecond = remaining;
          drawCountdown(remaining);
        }
      }
    }

    if (portalReconnectPending) {
      portalReconnectPending = false;
      portal.stop();
      WiFi.softAPdisconnect(true);
      portalActive = false;
      showBoot("Conectando WiFi...");
      if (!connectWifi() || !syncClock()) {
        startWifiPortal();
      } else {
        fetchRemoteConfig(false);
        showIdle();
      }
    }
    delay(5);
    return;
  }

  touch.read();
  const bool touched = touch.isTouched;
  if (touched && !touchWasDown) {
    const int x = constrain(map(touch.points[0].x, 480, 0, 0, 479), 0, 479);
    const int y = constrain(map(touch.points[0].y, 480, 0, 0, 479), 0, 479);
    handleTouch(x, y);
  }
  touchWasDown = touched;

  const uint32_t now = millis();

  if (uiState == UI_WAITING_PAYMENT) {
    if (now - paymentStartedAt >= PAYMENT_TIMEOUT_MS) {
      paymentId = "";
      showError("PAGO VENCIDO", "Toca volver e intenta nuevamente");
    } else if (now - lastPaymentPollAt >= PAYMENT_POLL_MS) {
      lastPaymentPollAt = now;
      pollPayment();
    }
  } else if (uiState == UI_OWNER_LINK && now - lastPaymentPollAt >= 5000) {
    lastPaymentPollAt = now;
    pollOwnerStatus();
  } else if (uiState == UI_PREPARING) {
    if (static_cast<int32_t>(now - prestartEndsAt) >= 0) {
      startService(pendingServiceSeconds);
    } else {
      const uint32_t remaining = (prestartEndsAt - now + 999) / 1000;
      if (remaining != lastCountdownSecond) {
        lastCountdownSecond = remaining;
        drawPrestartCountdown(remaining);
      }
      if (now - lastAnimationAt >= 180) {
        lastAnimationAt = now;
        drawTire(240, 350, 46, animationPhase++, C_GREEN);
      }
    }
  } else if (uiState == UI_RUNNING) {
    if (static_cast<int32_t>(now - relayEndsAt) >= 0) {
      showThanks();
    } else {
      const uint32_t remaining = (relayEndsAt - now + 999) / 1000;
      if (remaining != lastCountdownSecond) {
        lastCountdownSecond = remaining;
        drawCountdown(remaining);
      }
      if (now - lastAnimationAt >= 180) {
        lastAnimationAt = now;
        drawAirPulse(animationPhase++);
      }
    }
  } else if (uiState == UI_RELAY_TEST) {
    if (static_cast<int32_t>(now - relayTestEndsAt) >= 0) {
      relayOff();
      showIdle();
    } else {
      const uint32_t remaining = (relayTestEndsAt - now + 999) / 1000;
      if (remaining != lastCountdownSecond) {
        lastCountdownSecond = remaining;
        drawCountdown(remaining);
      }
    }
  } else if (uiState == UI_THANKS && static_cast<int32_t>(now - thanksEndsAt) >= 0) {
    fetchRemoteConfig(false);
    showIdle();
  } else if (uiState == UI_IDLE && WiFi.status() == WL_CONNECTED &&
             now - lastConfigRefreshAt >= CONFIG_REFRESH_MS) {
    fetchRemoteConfig(true);
  }

  if (uiState == UI_IDLE && now - lastAnimationAt >= 300) {
    lastAnimationAt = now;
    drawTire(105, 190, 62, animationPhase++);
  }

  if (uiState != UI_RUNNING && uiState != UI_PREPARING && uiState != UI_RELAY_TEST &&
      WiFi.status() != WL_CONNECTED &&
      now - lastWifiRetryAt >= WIFI_RETRY_MS) {
    lastWifiRetryAt = now;
    WiFi.reconnect();
  }

  delay(15);
}
