#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <ArduinoJson.h>
#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeSans12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>
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

// Paleta EVETEC Automotive: azul noche, superficies grafito y acentos electricos.
constexpr uint16_t C_BG = 0x020B;
constexpr uint16_t C_BG_2 = 0x0412;
constexpr uint16_t C_PANEL = 0x0C36;
constexpr uint16_t C_PANEL_2 = 0x147A;
constexpr uint16_t C_BORDER = 0x251E;
constexpr uint16_t C_SHADOW = 0x0105;
constexpr uint16_t C_WHITE = 0xFFFF;
constexpr uint16_t C_MUTED = 0x94B8;
constexpr uint16_t C_CYAN = 0x2E7F;
constexpr uint16_t C_BLUE = 0x1CFF;
constexpr uint16_t C_GREEN = 0x2F6D;
constexpr uint16_t C_RED = 0xF2AB;
constexpr uint16_t C_GOLD = 0xFE68;
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

const GFXfont *uiFont(uint8_t size) {
  if (size <= 1) return &FreeSans9pt7b;
  if (size == 2) return &FreeSans12pt7b;
  if (size == 3) return &FreeSansBold18pt7b;
  return &FreeSansBold24pt7b;
}

uint8_t uiFontScale(uint8_t size) {
  return size >= 6 ? 2 : 1;
}

void configureText(uint8_t size, uint16_t color) {
  display->setTextWrap(false);
  display->setFont(uiFont(size));
  display->setTextSize(uiFontScale(size));
  display->setTextColor(color);
}

void textAt(const String &text, int x, int y, uint8_t size, uint16_t color) {
  configureText(size, color);
  int16_t x1, y1;
  uint16_t w, h;
  display->getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  display->setCursor(x - x1, y - y1);
  display->print(text);
}

void centerText(const String &text, int y, uint8_t size, uint16_t color) {
  int16_t x1, y1;
  uint16_t w, h;
  configureText(size, color);
  display->getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  display->setCursor(max(0, (480 - static_cast<int>(w)) / 2) - x1, y - y1);
  display->print(text);
}

void button(int x, int y, int w, int h, uint16_t color, const String &label,
            uint16_t textColor = C_BG, uint8_t textSize = 3) {
  display->fillRoundRect(x + 3, y + 5, w, h, 16, C_SHADOW);
  display->fillRoundRect(x, y, w, h, 16, color);
  display->drawRoundRect(x, y, w, h, 16, C_BORDER);
  display->drawFastHLine(x + 18, y + 3, w - 36, C_WHITE);
  int16_t x1, y1;
  uint16_t tw, th;
  configureText(textSize, textColor);
  display->getTextBounds(label, 0, 0, &x1, &y1, &tw, &th);
  display->setCursor(x + (w - static_cast<int>(tw)) / 2 - x1,
                     y + (h - static_cast<int>(th)) / 2 - y1);
  display->print(label);
}

void header(const String &status, uint16_t color = C_CYAN) {
  display->fillCircle(31, 28, 16, C_BLUE);
  display->drawCircle(31, 28, 16, C_CYAN);
  textAt("E", 25, 20, 2, C_WHITE);
  textAt("EVETEC", 56, 14, 2, C_WHITE);
  textAt("AUTOMOTIVE", 57, 38, 1, C_MUTED);

  const uint16_t wifiColor = WiFi.status() == WL_CONNECTED ? C_GREEN : C_RED;
  display->drawCircle(451, 27, 11, C_BORDER);
  display->fillCircle(451, 27, 5, wifiColor);
  display->fillRoundRect(22, 54, 436, 25, 11, C_PANEL);
  display->fillCircle(37, 66, 4, color);
  textAt(status, 49, 60, 1, color);
}

void card(int x, int y, int w, int h, uint16_t accent = C_BORDER) {
  display->fillRoundRect(x + 4, y + 6, w, h, 18, C_SHADOW);
  display->fillRoundRect(x, y, w, h, 18, C_PANEL);
  display->drawRoundRect(x, y, w, h, 18, C_BORDER);
  display->fillRoundRect(x + 16, y, w - 32, 3, 1, accent);
}

void badge(int x, int y, int w, const String &label, uint16_t color) {
  display->fillRoundRect(x, y, w, 28, 12, C_PANEL_2);
  display->fillCircle(x + 14, y + 14, 4, color);
  textAt(label, x + 25, y + 10, 1, C_WHITE);
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
  display->fillRect(0, 115, 480, 365, C_BG_2);
  for (int y = 115; y < 480; y += 52) display->drawFastHLine(0, y, 480, C_PANEL);
  for (int x = 24; x < 480; x += 54) {
    for (int y = 108; y < 480; y += 54) display->fillCircle(x, y, 1, C_BORDER);
  }
  display->drawCircle(455, 126, 92, C_PANEL);
  display->drawCircle(455, 126, 118, C_PANEL);
}

void drawTire(int cx, int cy, int radius, uint8_t phase, uint16_t accent = C_CYAN) {
  display->fillCircle(cx, cy, radius + 7, C_PANEL);
  display->fillCircle(cx, cy, radius, C_BLACK);
  display->drawCircle(cx, cy, radius, accent);
  display->drawCircle(cx, cy, radius - 5, C_BORDER);
  display->fillCircle(cx, cy, radius - 20, C_PANEL);
  display->drawCircle(cx, cy, radius - 20, C_MUTED);
  display->drawCircle(cx, cy, radius - 22, accent);
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

  display->fillRect(cx + radius - 4, cy + 16, 12, 5, C_MUTED);
  display->drawLine(cx + radius + 7, cy + 18, cx + radius + 22, cy + 26, accent);
}

void drawAirPulse(uint8_t phase) {
  display->fillRect(25, 330, 430, 48, C_BG_2);
  display->drawLine(55, 356, 405, 356, C_BORDER);
  display->drawLine(55, 357, 405, 357, C_PANEL_2);
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
  display->fillCircle(240, 148, 54, C_BLUE);
  display->drawCircle(240, 148, 58, C_CYAN);
  centerText("E", 119, 5, C_WHITE);
  centerText("EVETEC", 225, 4, C_WHITE);
  centerText("AUTOMOTIVE AIR STATION", 275, 2, C_CYAN);
  card(70, 330, 340, 70, C_BLUE);
  centerText(message, 352, 2, C_WHITE);
  for (int i = 0; i < 3; i++) display->fillCircle(222 + i * 18, 425, 4, i == animationPhase % 3 ? C_GREEN : C_BORDER);
}

void showError(const String &title, const String &message) {
  relayOff();
  uiState = UI_ERROR;
  lastError = message;
  clearScreen();
  header("ATENCION REQUERIDA", C_RED);
  card(30, 105, 420, 220, C_RED);
  display->fillCircle(240, 150, 26, C_RED);
  centerText("!", 134, 3, C_WHITE);
  centerText(title, 195, 3, C_RED);
  centerText(message.substring(0, 34), 245, 2, C_WHITE);
  centerText(message.substring(34, 68), 278, 2, C_MUTED);
  button(70, 360, 340, 68, C_BLUE, "VOLVER", C_WHITE, 3);
}

void showIdle() {
  relayOff();
  uiState = UI_IDLE;
  paymentId = "";
  paymentLink = "";
  clearScreen();
  header(serviceActive ? "LISTO PARA USAR" : "FUERA DE SERVICIO",
         serviceActive ? C_GREEN : C_RED);
  centerText("AIRE PARA TU VIAJE", 91, 2, C_WHITE);
  card(22, 120, 436, 158, C_BLUE);
  drawTire(105, 199, 55, animationPhase, C_BLUE);
  display->drawFastVLine(185, 143, 112, C_BORDER);
  textAt("SERVICIO", 215, 143, 1, C_MUTED);
  textAt("INFLADO DE NEUMATICOS", 215, 163, 1, C_WHITE);
  textAt("DURACION", 215, 194, 1, C_MUTED);
  textAt(durationText(serviceSeconds), 215, 214, 2, C_CYAN);
  textAt("VALOR", 215, 244, 1, C_MUTED);
  textAt(moneyText(servicePrice), 322, 226, 4, C_GOLD);

  if (!ownerLinked && WiFi.status() == WL_CONNECTED) {
    centerText("Configuracion inicial del propietario", 286, 1, C_MUTED);
    button(42, 304, 396, 70, C_BLUE, "VINCULAR MERCADO PAGO", C_WHITE, 2);
  } else if (serviceActive && WiFi.status() == WL_CONNECTED) {
    centerText("Estacione, conecte la manguera y comience", 286, 1, C_MUTED);
    button(42, 304, 396, 70, C_GREEN, "INFLAR AHORA", C_BG, 3);
  } else {
    button(42, 304, 396, 70, C_PANEL_2, "NO DISPONIBLE", C_MUTED, 2);
  }

  badge(22, 405, 190, ownerLinked ? "COBROS ACTIVOS" : "CUENTA PENDIENTE",
        ownerLinked ? C_GREEN : C_GOLD);
  button(274, 397, 184, 48, C_PANEL_2, "PRUEBA TECNICA", C_WHITE, 1);
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
  header("PAGO SEGURO", C_GOLD);
  centerText("ESCANEA PARA COMENZAR", 91, 2, C_WHITE);
  card(67, 118, 346, 294, C_GOLD);
  if (!drawQr(paymentLink, 240, 265, 272)) {
    showError("QR NO DISPONIBLE", "El enlace de pago es demasiado largo");
    return;
  }
  badge(76, 428, 145, moneyText(servicePrice), C_GOLD);
  badge(259, 428, 145, durationText(serviceSeconds), C_CYAN);
}

void drawCountdown(uint32_t remaining) {
  display->fillRect(60, 190, 360, 118, C_PANEL);
  char value[12];
  snprintf(value, sizeof(value), "%02lu:%02lu",
           static_cast<unsigned long>(remaining / 60),
           static_cast<unsigned long>(remaining % 60));
  centerText(value, 213, 7, C_WHITE);
}

void drawPrestartCountdown(uint32_t remaining) {
  display->fillRect(155, 238, 170, 64, C_PANEL);
  centerText(String(remaining), 242, 6, C_GOLD);
}

void startService(uint32_t seconds) {
  serviceSeconds = max<uint32_t>(1, min<uint32_t>(seconds, 3600));
  relayOn();
  relayEndsAt = millis() + serviceSeconds * 1000UL;
  lastCountdownSecond = UINT32_MAX;
  uiState = UI_RUNNING;
  clearScreen();
  header("SERVICIO EN CURSO", C_GREEN);
  centerText("INFLADOR ACTIVO", 96, 3, C_GREEN);
  card(42, 145, 396, 174, C_GREEN);
  centerText("TIEMPO RESTANTE", 165, 1, C_MUTED);
  drawCountdown(serviceSeconds);
  drawAirPulse(animationPhase++);
  centerText("El equipo se detiene automaticamente", 388, 1, C_MUTED);
  button(150, 420, 180, 38, C_RED, "DETENER", C_WHITE, 1);
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
  centerText("TODO LISTO", 96, 4, C_GREEN);
  card(62, 155, 356, 245, C_GREEN);
  centerText("Prepare la manguera", 175, 2, C_WHITE);
  centerText("Inicio automatico en", 215, 1, C_MUTED);
  drawPrestartCountdown(prestartSeconds);
  drawTire(240, 350, 38, animationPhase, C_GREEN);
  button(140, 420, 200, 38, C_GREEN, "INICIAR AHORA", C_BG, 1);
}

void startRelayTest() {
  relayOn();
  relayTestEndsAt = millis() + relayTestSeconds * 1000UL;
  lastCountdownSecond = UINT32_MAX;
  uiState = UI_RELAY_TEST;
  clearScreen();
  header("PRUEBA TECNICA", C_GOLD);
  centerText("SALIDA GPIO 40", 103, 3, C_GOLD);
  card(42, 155, 396, 185, C_GOLD);
  centerText("RELE ACTIVO", 174, 2, C_WHITE);
  drawCountdown(relayTestSeconds);
  centerText("Pulso de comprobacion seguro", 348, 1, C_MUTED);
  button(130, 390, 220, 58, C_RED, "APAGAR AHORA", C_WHITE, 2);
}

void showThanks() {
  relayOff();
  uiState = UI_THANKS;
  thanksEndsAt = millis() + 5000;
  clearScreen();
  header("SERVICIO FINALIZADO", C_GREEN);
  display->fillCircle(240, 170, 58, C_GREEN);
  display->drawCircle(240, 170, 64, C_CYAN);
  display->drawLine(211, 171, 231, 190, C_WHITE);
  display->drawLine(231, 190, 273, 145, C_WHITE);
  centerText("GRACIAS", 258, 5, C_WHITE);
  centerText("Tu vehiculo esta listo", 324, 2, C_CYAN);
  centerText("Buen viaje", 375, 2, C_MUTED);
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
  centerText("PUESTA EN MARCHA", 92, 2, C_WHITE);
  card(32, 125, 416, 210, C_GOLD);
  badge(52, 148, 48, "1", C_GOLD);
  textAt("Conectate a la red", 118, 154, 1, C_MUTED);
  textAt("EVETEC-INFLADOR-SETUP", 118, 178, 2, C_CYAN);
  textAt("Clave  12345678", 118, 211, 1, C_WHITE);
  badge(52, 255, 48, "2", C_CYAN);
  textAt("Abre en tu navegador", 118, 261, 1, C_MUTED);
  textAt("192.168.4.1", 118, 285, 2, C_WHITE);
  button(87, 365, 306, 60, C_PANEL_2, "PROBAR RELE GPIO 40", C_WHITE, 1);
  centerText("Disponible incluso sin Internet", 447, 1, C_MUTED);
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
