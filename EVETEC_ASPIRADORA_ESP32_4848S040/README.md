# EVETEC Inflador QR - ESP32-4848S040

Firmware para un inflador de neumáticos operado por pago de Mercado Pago.

## Flujo

1. La pantalla se conecta a Wi-Fi. En el primer arranque crea la red
   `EVETEC-INFLADOR-SETUP` (clave `12345678`) y permite guardar la red desde
   `http://192.168.4.1`.
2. Si el equipo todavía no tiene propietario, la pantalla muestra **VINCULAR CUENTA**.
   El futuro cliente escanea el QR y autoriza su cuenta de Mercado Pago.
3. El usuario toca **INFLAR NEUMATICOS**.
4. El backend crea una preferencia de Checkout Pro y la pantalla genera el QR.
5. El ESP32 reclama el pago al backend. El backend consulta Mercado Pago y valida
   estado, referencia externa, monto y moneda.
6. El backend entrega una autorización de consumo único. La pantalla confirma
   **LISTO PARA USAR** y espera 15 segundos para preparar la manguera.
7. GPIO40 (`relay1` en H1) queda activo durante el tiempo vendido. Al terminar,
   el relé se apaga y aparece la pantalla de agradecimiento.

La pantalla principal incluye **PROBAR RELE**, que activa GPIO40 durante 3 segundos
sin crear un pago. El pulso se puede apagar inmediatamente tocando la pantalla.
El mismo botón aparece en la pantalla de configuración Wi-Fi, por lo que la salida
se puede comprobar antes de conectar el equipo a Internet.

El estado seguro del relé es apagado: se fuerza antes de inicializar display,
Wi-Fi o red. Un reinicio durante el servicio apaga la salida.

## Hardware

- Placa: ESP32-4848S040, ESP32-S3-WROOM-1U N16R8.
- Display: ST7701S RGB 480x480.
- Touch: GT911, SDA GPIO19, SCL GPIO45.
- Backlight: GPIO38.
- Salida: H1 `relay1`, GPIO40, activa en HIGH.

GPIO40 es una señal de 3,3 V. Debe conectarse a un módulo de relé/contactor
aislado y apto para la bobina/carga. La aspiradora nunca se conecta directamente
al ESP32.

## Compilar y cargar con PlatformIO

El proyecto principal ahora usa PlatformIO y fija todas las versiones necesarias.
Las bibliotecas especiales de esta pantalla (`Arduino_GFX 1.2.9`, `Touch_GT911`
y `QRCode`) están incluidas en `lib/`, por lo que no hay que buscarlas ni
instalarlas manualmente.

Abrir esta carpeta desde VS Code con la extensión PlatformIO o ejecutar:

```powershell
python -m venv .venv-platformio
.\.venv-platformio\Scripts\python.exe -m pip install -r requirements-platformio.txt
.\.venv-platformio\Scripts\platformio.exe run
.\.venv-platformio\Scripts\platformio.exe run --target upload
```

La configuración de placa, memoria, particiones y puerto está en
`platformio.ini`. El firmware compilado queda en
`.pio\build\esp32-4848s040\firmware.bin`.

En `build/` también se guardan los binarios probados del firmware, bootloader y
particiones, útiles para recuperar el dispositivo sin recompilar.

## Compilación Arduino heredada

La configuración anterior de Arduino CLI se conserva como referencia. Usa:

- Arduino ESP32 core `esp32:esp32` 2.0.17.
- GFX Library for Arduino 1.2.9.
- ArduinoJson 6.x.
- Touch_GT911.
- QRCode 0.0.1, incluido en `libraries/`.

FQBN recomendado:

```text
esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=default,UploadMode=default
```

Antes de proteger la API con `DEVICE_API_KEY`, cargar el mismo valor tanto en el
entorno del backend como en la constante del firmware.

## Interfaz de producto

La interfaz utiliza una identidad visual EVETEC Automotive de alto contraste,
tarjetas de información, estados consistentes y animaciones discretas. No usa
imágenes externas ni archivos pesados: todos los elementos se dibujan en el
ESP32 para mantener tiempos de respuesta previsibles y facilitar el reemplazo
de una pantalla en campo.

Los textos usan la familia proporcional FreeSans y FreeSans Bold en cuatro
jerarquías visuales. Esto evita la apariencia pixelada de la fuente clásica de
Arduino y mantiene títulos, botones, valores y mensajes alineados mediante sus
métricas reales.

## Configuración remota

El equipo conserva el ID productivo `ASPIRADORA_BASIC_001`. El precio, la duración del relé, la espera
previa y la duración de prueba se modifican en:

`https://evetec-api.onrender.com/admin`

La configuración inicial es ARS 10, 240 segundos de servicio, 15 segundos de
preparación y 3 segundos de prueba. La pantalla consulta los cambios cada 30
segundos cuando está libre.

## Seguridad pendiente para produccion

- Cambiar la clave del punto de acceso de configuración.
- Usar una clave distinta por dispositivo, no una global.
- Guardar tokens OAuth cifrados en una base de datos persistente.
- Implementar rotación automática de refresh tokens OAuth.
- Añadir contactor, protección térmica, fusible y paro físico adecuados a la
  potencia real del inflador.
