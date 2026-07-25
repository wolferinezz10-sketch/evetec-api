# EVETEC Aspiradora QR - ESP32-4848S040

Firmware de prototipo para una aspiradora de autos operada por pago de Mercado Pago.

## Flujo

1. La pantalla se conecta a Wi-Fi. En el primer arranque crea la red
   `EVETEC-ASPIRADORA-SETUP` (clave `12345678`) y permite guardar la red desde
   `http://192.168.4.1`.
2. El usuario toca **INICIAR**.
3. El backend crea una preferencia de Checkout Pro y la pantalla genera el QR.
4. El ESP32 reclama el pago al backend. El backend consulta Mercado Pago y valida
   estado, referencia externa, monto y moneda.
5. El backend entrega una autorización de consumo único.
6. GPIO40 (`relay1` en H1) queda activo durante el tiempo vendido. Al terminar,
   el relé se apaga y aparece la pantalla de agradecimiento.

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

## Compilar y cargar

La compilación usa:

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

## Configuracion inicial de prueba

El backend queda con el plan básico en ARS 10 por 240 segundos. Si Mercado Pago
rechaza ese importe por el mínimo vigente de la cuenta, cambiarlo a ARS 20 desde
el panel administrativo.

## Seguridad pendiente para produccion

- Cambiar la clave del punto de acceso de configuración.
- Usar una clave distinta por dispositivo, no una global.
- Guardar tokens OAuth cifrados en una base de datos persistente.
- Implementar rotación automática de refresh tokens OAuth.
- Añadir contactor, protección térmica, fusible y paro físico adecuados a la
  potencia real de la aspiradora.
