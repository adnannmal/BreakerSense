# BreakerSense
Senior Design Project

By: Adnan Malik, Darren Peng, James McCormack

## Remote breaker control

The dashboard queues ON/OFF commands for up to 30 seconds. The ESP32 firmware must be
flashed with the remote-command polling changes in `Firmware/src/main.cpp`; it polls
using its device API key and reports the contactor state with its readings. The
dashboard displays the reported state and does not treat a queued command as proof
that the contactor changed.

Remote control is not a safety-rated protection system. Use only with appropriately
rated hardware and independent electrical protection, and have the installation
validated by a qualified professional.