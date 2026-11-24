# ESP32 setup

## 1. Register the breaker

In the BreakerSense dashboard, add a breaker and assign its logical circuit/channel
(for example, `Panel A / Circuit 1`). Registration creates a device API key that is
shown once in the setup dialog. Copy the generated configuration before closing it.
The key is a credential; do not commit it or share it.

## 2. Configure and upload the firmware

Copy `include/secrets.example.h` to `include/secrets.h`. Set the Wi-Fi network name
and password, and use the exact device ID and API key shown by the dashboard. The
dashboard ignores `include/secrets.h` through `.gitignore`.

Open the `Firmware` folder as a PlatformIO project, build the `esp32dev` environment,
upload it to the ESP32, and open the serial monitor at 9600 baud. The firmware reports
Wi-Fi, time synchronization, and authenticated backend upload results there.

## 3. Verify the connection

The dashboard checks for an authenticated device message automatically. It marks the
device connected after the backend receives a valid payload, including a status-only
payload when sensor readings are unavailable. If it remains offline, check the
firmware serial output and confirm the Wi-Fi credentials, device ID, and API key.

The channel is software-only circuit metadata. It does not select GPIO pins or change
contactor behavior.

## Safety

The firmware output is not safety-rated. Use only a verified isolated low-voltage test
indicator during development; the output is disabled by default in firmware. Do not
connect it to mains or rely on it for electrical protection. Have any real installation
reviewed by a qualified professional.
