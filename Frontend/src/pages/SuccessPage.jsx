
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { api } from "../api";
import "./SuccessPage.css";

ChartJS.register(CategoryScale, Filler, LinearScale, LineElement, PointElement, Tooltip);

const EMPTY_FORM = {
  deviceId: "",
  name: "",
  location: "",
  channel: "",
  capacity: "",
  status: "inactive",
};

function escapeCppString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function createSecretsHeader({
  deviceId,
  apiKey,
  wifiSsid = "",
  wifiPassword = "",
}) {
  const wifiConfigured = wifiSsid.length > 0;
  return [
    "#pragma once",
    "",
    `#define WIFI_SSID "${escapeCppString(wifiConfigured ? wifiSsid : "replace-with-your-wifi-name")}"`,
    `#define WIFI_PASSWORD "${escapeCppString(wifiConfigured ? wifiPassword : "replace-with-your-wifi-password")}"`,
    `#define DEVICE_ID "${escapeCppString(deviceId)}"`,
    `#define DEVICE_API_KEY "${escapeCppString(apiKey)}"`,
    "",
  ].join("\n");
}

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "--";
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function SuccessPage() {
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [dashboardResponse, setDashboardResponse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [setupCredentials, setSetupCredentials] = useState(null);
  const [setupCopyMessage, setSetupCopyMessage] = useState("");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [commandError, setCommandError] = useState("");
  const [isCommanding, setIsCommanding] = useState(false);
  const [editingChannelDeviceId, setEditingChannelDeviceId] = useState("");
  const [channelDraft, setChannelDraft] = useState("");
  const [channelError, setChannelError] = useState("");
  const [isSavingChannel, setIsSavingChannel] = useState(false);
  const [keyRotationError, setKeyRotationError] = useState("");
  const [isRotatingKey, setIsRotatingKey] = useState(false);
  const addBreakerButtonRef = useRef(null);
  const dialogRef = useRef(null);
  const isSavingRef = useRef(isSaving);
  const closeSetupWizard = useCallback(() => {
    if (
      window.confirm(
        "Close setup and discard the one-time API key? You will need to rotate the key to view a new one."
      )
    ) {
      setSetupCredentials(null);
      setSetupCopyMessage("");
      setWifiSsid("");
      setWifiPassword("");
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function loadDevices() {
      try {
        const result = await api.getDevices();
        if (!active) return;
        if (!Array.isArray(result)) {
          throw new Error("Unexpected response while loading breakers");
        }
        const list = result;
        setDevices(list);
        setSelectedDeviceId((previous) =>
          list.some((device) => device.device_id === previous)
            ? previous
            : list[0]?.device_id || ""
        );
        setDataError("");
      } catch (err) {
        if (active) setDataError(err.message);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadDevices();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedDeviceId) return;

    let active = true;
    let inFlight = false;

    async function loadDashboard() {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await api.getDashboard(selectedDeviceId);
        if (!active) return;
        if (
          !result?.device ||
          result.device.device_id !== selectedDeviceId ||
          !Array.isArray(result.alerts) ||
          !Array.isArray(result.history)
        ) {
          throw new Error("Unexpected dashboard data returned by the backend");
        }
        setDashboardResponse(result);
        setDataError("");
      } catch (err) {
        if (active) {
          setDataError(err.message);
          setDashboardResponse(null);
        }
      } finally {
        inFlight = false;
      }
    }

    loadDashboard();
    const interval = setInterval(loadDashboard, 3000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!isModalOpen && !setupCredentials) return undefined;
    const dialog = dialogRef.current;
    const addBreakerButton = addBreakerButtonRef.current;
    const previouslyFocused = document.activeElement;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const focusableElements = () =>
      Array.from(dialog?.querySelectorAll(focusableSelector) || []);

    const initialFocus =
      dialog?.querySelector(".setup-wifi-fields input") ||
      dialog?.querySelector('input[autofocus]') ||
      focusableElements()[0];
    initialFocus?.focus();

    function handleDialogKeyDown(event) {
      if (event.key === "Escape") {
        if (!isSavingRef.current) {
          event.preventDefault();
          if (setupCredentials) {
            closeSetupWizard();
          } else {
            setIsModalOpen(false);
          }
        }
        return;
      }

      if (event.key !== "Tab" || !dialog) return;
      const elements = focusableElements();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) {
        event.preventDefault();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      } else if (addBreakerButton?.isConnected) {
        addBreakerButton.focus();
      }
    };
  }, [closeSetupWizard, isModalOpen, setupCredentials]);

  const dashboard =
    dashboardResponse?.device?.device_id === selectedDeviceId
      ? dashboardResponse
      : null;
  const device = dashboard?.device;
  const latest = dashboard?.latest;
  const readingAge = latest?.updated_at && dashboard?.server_time
    ? new Date(dashboard.server_time).getTime() -
      new Date(latest.updated_at).getTime()
    : null;
  const readingFresh =
    readingAge !== null && readingAge >= 0 && readingAge < 15000;
  const heartbeatAge = device?.last_seen_at && dashboard?.server_time
    ? new Date(dashboard.server_time).getTime() -
      new Date(device.last_seen_at).getTime()
    : null;
  const deviceConnected =
    heartbeatAge !== null && heartbeatAge >= 0 && heartbeatAge < 15000;
  const isEditingChannel =
    Boolean(selectedDeviceId) && editingChannelDeviceId === selectedDeviceId;
  const normalizedStatus = device?.status?.toUpperCase();
  const statusTone =
    normalizedStatus === "ON"
      ? "on"
      : normalizedStatus === "TRIPPED"
        ? "tripped"
        : normalizedStatus === "OFF"
          ? "off"
          : "unknown";

  const breaker = {
    name: device?.nickname || device?.device_id || "No breaker registered",
    location: device?.location || "No location set",
    status: device?.status || "Unknown",
    detail: !latest
      ? "Waiting for first sensor reading"
      : readingFresh
        ? "Receiving sensor measurements"
        : "Sensor readings are stale",
    uptime:
      dashboard?.uptime_pct == null
        ? "--"
        : `${formatNumber(dashboard.uptime_pct, 2)}%`,
    lastEvent: dashboard?.last_event?.message || "No recent alerts",
  };
  const commandPending = Boolean(device?.requested_status);
  const commandTarget =
    normalizedStatus === "ON" || normalizedStatus === "TRIPPED" ? "OFF" : "ON";
  const controlDisabled =
    isCommanding ||
    commandPending ||
    !device ||
    normalizedStatus === "TRIPPED" ||
    !["ON", "OFF", "TRIPPED"].includes(normalizedStatus) ||
    (commandTarget === "ON" &&
      (!readingFresh || normalizedStatus !== "OFF"));
  const controlDisabledReason = !device
    ? "Select a registered breaker to control it."
    : commandPending
      ? `Waiting for the breaker to report ${device.requested_status}.`
      : normalizedStatus === "TRIPPED"
        ? "A tripped breaker must be inspected and reset before it can be turned on."
        : !["ON", "OFF"].includes(normalizedStatus)
          ? "The breaker has not reported a controllable state."
        : commandTarget === "ON" && !readingFresh
          ? "A recent device reading is required before turning on."
          : "";

  function makeSensor(label, value, unit, threshold, tone) {
    const valid = value !== null && value !== undefined && Number.isFinite(Number(value));
    const overLimit =
      valid && threshold != null && Number(value) > Number(threshold);
    return {
      label,
      value: valid ? formatNumber(value) : "--",
      unit,
      status: !valid
        ? "No data"
        : !readingFresh
          ? "Stale"
          : overLimit
            ? "Watch"
            : "Normal",
      tone: overLimit ? "amber" : tone,
    };
  }

  const sensors = [
    makeSensor("Voltage", latest?.voltage, "V", device?.voltage_threshold, "blue"),
    makeSensor("Current", latest?.current, "A", device?.current_threshold, "navy"),
    makeSensor("Power", latest?.power, "W", device?.power_threshold, "blue"),
    makeSensor(
      "Temperature",
      latest?.temperature,
      "°C",
      device?.temperature_threshold,
      "amber"
    ),
  ];

  const alerts = (dashboard?.alerts || []).map((alert) => ({
    id: alert.id,
    title: alert.title || "Breaker alert",
    detail: alert.message || "",
    time: formatDate(alert.created_at),
    severity: alert.severity || "Medium",
    tone: alert.severity === "High" ? "amber" : "blue",
  }));

  const history = dashboard?.history || [];
  const chartData = {
    labels: history.map((point) =>
      new Date(point.t).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    ),
    datasets: [
      {
        label: "Current draw",
        data: history.map((point) =>
          point.current == null ? null : Number(point.current)
        ),
        borderColor: "#1e3a5f",
        backgroundColor: "rgba(30, 58, 95, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: "#1e3a5f",
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { displayColors: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: "#718096" } },
      y: {
        border: { display: false },
        grid: { color: "#e1e7ef" },
        ticks: { color: "#718096" },
      },
    },
  };

  function handleFormChange(event) {
    const { name, value } = event.target;
    setFormData((current) => ({ ...current, [name]: value }));
  }

  function handleGenerateDeviceId() {
    if (!window.crypto?.getRandomValues) {
      setFormError("This browser cannot generate a secure ID. Enter a unique ID manually.");
      return;
    }
    const bytes = window.crypto.getRandomValues(new Uint8Array(8));
    const suffix = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    setFormData((current) => ({ ...current, deviceId: `esp32-${suffix}` }));
    setFormError("");
  }

  async function handleAddBreaker(event) {
    event.preventDefault();
    if (isSaving) return;
    if (
      !formData.deviceId.trim() ||
      !formData.name.trim() ||
      !formData.location.trim() ||
      !formData.channel.trim() ||
      !formData.capacity ||
      !Number.isFinite(Number(formData.capacity)) ||
      Number(formData.capacity) <= 0
    ) {
      setFormError("Complete all fields, including a channel, with a valid positive capacity.");
      return;
    }

    setFormError("");
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      const newDevice = await api.addDevice({
        device_id: formData.deviceId.trim(),
        nickname: formData.name.trim(),
        location: formData.location.trim(),
        channel: formData.channel.trim(),
        capacity_amps: Number(formData.capacity),
        status: "OFF",
      });
      if (typeof newDevice.api_key !== "string" || !newDevice.api_key) {
        throw new Error(
          "The breaker was registered, but setup credentials were not returned. Rotate its API key before configuring the ESP32."
        );
      }
      const { api_key: apiKey, ...registeredDevice } = newDevice;
      setDevices((current) => [
        ...current.filter((item) => item.device_id !== registeredDevice.device_id),
        registeredDevice,
      ]);
      setSelectedDeviceId(newDevice.device_id);
      setSetupCopyMessage("");
      setWifiSsid("");
      setWifiPassword("");
      setSetupCredentials({
        deviceId: newDevice.device_id,
        apiKey,
      });
      setFormData({ ...EMPTY_FORM });
      setIsModalOpen(false);
      setDataError("");
    } catch (err) {
      setFormError(err.message);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }

  async function handleDeleteBreaker() {
    const selectedDevice = devices.find(
      (item) => item.device_id === selectedDeviceId
    );
    if (!selectedDevice || isDeleting) return;

    const deviceName = selectedDevice.nickname || selectedDevice.device_id;
    const confirmed = window.confirm(
      `Delete "${deviceName}"? This permanently removes the breaker, its readings, history, alerts, and device key. This action cannot be undone.`
    );
    if (!confirmed) return;

    setDeleteError("");
    setIsDeleting(true);
    try {
      await api.deleteDevice(selectedDevice.device_id);
      const updatedDevices = devices.filter(
        (item) => item.device_id !== selectedDevice.device_id
      );
      setDevices(updatedDevices);
      setSelectedDeviceId(updatedDevices[0]?.device_id || "");
      setDataError("");
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleToggleBreaker() {
    if (controlDisabled) return;

    const targetStatus = commandTarget;
    if (
      targetStatus === "ON" &&
      !window.confirm(
        "Turn on this breaker? This will energize the connected circuit. Confirm that the circuit and connected equipment are safe to energize."
      )
    ) {
      return;
    }

    setCommandError("");
    setIsCommanding(true);
    try {
      const command = await api.commandDevice(selectedDeviceId, targetStatus);
      setDashboardResponse((current) =>
        current?.device?.device_id === selectedDeviceId
          ? {
              ...current,
              device: {
                ...current.device,
                requested_status: command.requested_status,
              },
            }
          : current
      );
    } catch (err) {
      setCommandError(err.message);
    } finally {
      setIsCommanding(false);
    }
  }

  async function copyFirmwareConfig() {
    if (!wifiSsid) {
      setSetupCopyMessage("Enter the ESP32's Wi-Fi network name first.");
      return;
    }
    const config = createSecretsHeader({
      ...setupCredentials,
      wifiSsid,
      wifiPassword,
    });
    if (!navigator.clipboard?.writeText) {
      setSetupCopyMessage("Clipboard access is unavailable. Select and copy the code below.");
      return;
    }
    try {
      await navigator.clipboard.writeText(config);
      setSetupCopyMessage("Firmware configuration copied.");
    } catch (error) {
      setSetupCopyMessage(
        `Could not copy configuration: ${error.message || "clipboard access was denied"}`
      );
    }
  }

  function startEditingChannel() {
    setChannelDraft(device?.channel || "");
    setChannelError("");
    setEditingChannelDeviceId(selectedDeviceId);
  }

  async function handleChannelSubmit(event) {
    event.preventDefault();
    if (!selectedDeviceId || isSavingChannel) return;
    const channel = channelDraft.trim();
    if (channel.length > 80) {
      setChannelError("Channel labels must be 80 characters or fewer.");
      return;
    }

    setChannelError("");
    setIsSavingChannel(true);
    try {
      const updated = await api.updateDeviceChannel(
        selectedDeviceId,
        channel || null
      );
      setDevices((current) =>
        current.map((item) =>
          item.device_id === updated.device_id
            ? { ...item, channel: updated.channel }
            : item
        )
      );
      setDashboardResponse((current) =>
        current?.device?.device_id === updated.device_id
          ? {
              ...current,
              device: { ...current.device, channel: updated.channel },
            }
          : current
      );
      setEditingChannelDeviceId("");
    } catch (err) {
      setChannelError(err.message);
    } finally {
      setIsSavingChannel(false);
    }
  }

  async function handleRotateDeviceKey() {
    if (!selectedDeviceId || isRotatingKey) return;
    const confirmed = window.confirm(
      "Rotate this device's API key? Its current firmware key will stop working immediately until you update and upload the new configuration."
    );
    if (!confirmed) return;

    setKeyRotationError("");
    setIsRotatingKey(true);
    try {
      const result = await api.rotateDeviceKey(selectedDeviceId);
      setDevices((current) =>
        current.map((item) =>
          item.device_id === result.device_id
            ? { ...item, last_seen_at: null }
            : item
        )
      );
      setDashboardResponse((current) =>
        current?.device?.device_id === result.device_id
          ? {
              ...current,
              device: { ...current.device, last_seen_at: null },
            }
          : current
      );
      setSetupCopyMessage("");
      setWifiSsid("");
      setWifiPassword("");
      setSetupCredentials({
        deviceId: result.device_id,
        apiKey: result.api_key,
      });
    } catch (err) {
      setKeyRotationError(err.message);
    } finally {
      setIsRotatingKey(false);
    }
  }

  return (
    <div className="dashboard-page">
      {loading && <p>Loading registered breakers...</p>}
      {dataError && (
        <p role="alert" style={{ color: "#b42318", marginBottom: 16 }}>
          Backend error: {dataError}
        </p>
      )}
      {setupCredentials && (
        <div className="modal-backdrop setup-backdrop" role="presentation">
          <div
            className="breaker-modal provisioning-modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="setup-heading"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">ESP32 setup</p>
                <h2 id="setup-heading">Configure and verify your device</h2>
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Close setup and discard the one-time API key"
                onClick={closeSetupWizard}
              >
                ×
              </button>
            </div>
            <p className="setup-warning">
              The device API key is shown only once. Enter Wi-Fi credentials to prepare
              the firmware file. They stay in this page and are not sent to BreakerSense.
            </p>
            <ol className="setup-steps">
              <li>Save the generated file as <code>Firmware/include/secrets.h</code>.</li>
              <li>Build and upload the <code>esp32dev</code> firmware; open its serial monitor at 9600 baud.</li>
              <li>Wait for an authenticated device contact below. The dashboard checks automatically.</li>
            </ol>
            <div className="setup-wifi-fields">
              <label>
                Wi-Fi network name
                <input
                  autoComplete="off"
                  value={wifiSsid}
                  onChange={(event) => {
                    setWifiSsid(event.target.value);
                    setSetupCopyMessage("");
                  }}
                  placeholder="Network name"
                />
              </label>
              <label>
                Wi-Fi password
                <input
                  autoComplete="new-password"
                  type="password"
                  value={wifiPassword}
                  onChange={(event) => {
                    setWifiPassword(event.target.value);
                    setSetupCopyMessage("");
                  }}
                  placeholder="Password"
                />
                <span className="form-hint">Leave blank for an open Wi-Fi network.</span>
              </label>
            </div>
            <pre className="firmware-config"><code>{createSecretsHeader({
              ...setupCredentials,
              wifiSsid,
              wifiPassword,
            })}</code></pre>
            <div className="setup-copy-row">
              <button
                className="submit-button"
                type="button"
                onClick={copyFirmwareConfig}
                disabled={!wifiSsid}
              >
                Copy firmware config
              </button>
              <span role="status" aria-live="polite">{setupCopyMessage}</span>
            </div>
            <div className={`setup-connection ${deviceConnected && selectedDeviceId === setupCredentials.deviceId ? "setup-connection--connected" : ""}`}>
              <span
                className="connection-dot"
                aria-hidden="true"
              />
              <div role="status" aria-live="polite">
                <strong>
                  {deviceConnected && selectedDeviceId === setupCredentials.deviceId
                    ? "Connection verified"
                    : "Waiting for ESP32"}
                </strong>
                <p>
                  {deviceConnected && selectedDeviceId === setupCredentials.deviceId
                    ? "The backend received an authenticated device message."
                    : "After upload, the ESP32 should report within a few seconds. Check Wi-Fi, device credentials, and the serial monitor if it stays offline."}
                </p>
              </div>
              <span className="muted-text">
                Last authenticated contact: {formatDate(
                  selectedDeviceId === setupCredentials.deviceId
                    ? device?.last_seen_at
                    : null
                )}
              </span>
            </div>
            <div className="modal-actions">
              <button className="submit-button" type="button" onClick={() => {
                setSetupCredentials(null);
                setSetupCopyMessage("");
                setWifiSsid("");
                setWifiPassword("");
              }}>
                I saved the firmware config
              </button>
            </div>
          </div>
        </div>
      )}
      {!loading && !dataError && devices.length === 0 && (
        <p>No breakers registered yet. Click Add breaker to begin.</p>
      )}

      <header className="dashboard-header">
        <div>
          <p className="eyebrow">BreakerSense / Operations</p>
          <h1>System overview</h1>
        </div>
        <div className="dashboard-header__actions">
          <Link className="account-link" to="/account" viewTransition>
            Account
          </Link>
          {devices.length > 1 && (
            <select
              aria-label="Select breaker"
              value={selectedDeviceId}
              onChange={(event) => setSelectedDeviceId(event.target.value)}
            >
              {devices.map((item) => (
                <option key={item.device_id} value={item.device_id}>
                  {item.nickname || item.device_id}
                </option>
              ))}
            </select>
          )}
          <button
            ref={addBreakerButtonRef}
            className="add-breaker-button"
            type="button"
            onClick={() => setIsModalOpen(true)}
          >
            <span aria-hidden="true">+</span>
            Add breaker
          </button>
          <div className="connection-status">
            <span
              className="connection-dot"
              aria-hidden="true"
              style={{ backgroundColor: deviceConnected ? "#1e3a5f" : "#94a3b8" }}
            />
            <span role="status" aria-live="polite">
              {deviceConnected ? "Connected" : "Waiting for device"}
            </span>
            <span className="updated-time">
              Last contact {formatDate(device?.last_seen_at)}
            </span>
          </div>
        </div>
      </header>

      <main className="dashboard-content">
        <section className="breaker-card" aria-labelledby="breaker-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Circuit breaker status</p>
              <h2 id="breaker-heading">{breaker.name}</h2>
              <p className="muted-text">{breaker.location}</p>
            </div>
            <div className="breaker-card__actions">
              <span className={`status-pill status-pill--${statusTone}`}>
                <span className="status-dot" aria-hidden="true" />
                {breaker.status}
              </span>
              {selectedDeviceId && (
                <button
                  className="device-setup-button"
                  type="button"
                  onClick={handleRotateDeviceKey}
                  disabled={isRotatingKey}
                >
                  {isRotatingKey ? "Rotating key..." : "Reconfigure ESP32"}
                </button>
              )}
              {selectedDeviceId && (
                <button
                  className="delete-breaker-button"
                  type="button"
                  onClick={handleDeleteBreaker}
                  disabled={isDeleting}
                >
                  {isDeleting ? "Deleting..." : "Delete breaker"}
                </button>
              )}
            </div>
          </div>
          {keyRotationError && (
            <p className="delete-breaker-error" role="alert">
              Could not reconfigure ESP32: {keyRotationError}
            </p>
          )}
          <div className="breaker-channel">
            <div>
              <span className="metric-label">Assigned channel</span>
              <strong>{device?.channel || "Unassigned"}</strong>
            </div>
            {!isEditingChannel && (
              <button
                className="channel-edit-button"
                type="button"
                onClick={startEditingChannel}
                disabled={!device}
              >
                {device?.channel ? "Change channel" : "Assign channel"}
              </button>
            )}
            {isEditingChannel && (
              <form className="channel-edit-form" onSubmit={handleChannelSubmit}>
                <label>
                  Logical circuit/channel
                  <input
                    autoFocus
                    maxLength={80}
                    value={channelDraft}
                    onChange={(event) => setChannelDraft(event.target.value)}
                    placeholder="e.g. Panel A / Circuit 1"
                  />
                </label>
                {channelError && <p className="form-error" role="alert">{channelError}</p>}
                <div className="modal-actions">
                  <button
                    className="cancel-button"
                    type="button"
                    onClick={() => setEditingChannelDeviceId("")}
                    disabled={isSavingChannel}
                  >
                    Cancel
                  </button>
                  <button className="submit-button" type="submit" disabled={isSavingChannel}>
                    {isSavingChannel ? "Saving..." : "Save channel"}
                  </button>
                </div>
              </form>
            )}
          </div>
          <div className="breaker-control">
            <div className="breaker-control__copy">
              <strong>Contactor control</strong>
              <p>
                {controlDisabledReason ||
                  `The breaker is reported ${normalizedStatus?.toLowerCase() || "unknown"}.`}
              </p>
            </div>
            <button
              className={`control-breaker-button control-breaker-button--${commandTarget.toLowerCase()}`}
              type="button"
              onClick={handleToggleBreaker}
              disabled={controlDisabled}
            >
              {isCommanding
                ? "Sending..."
                : commandPending
                  ? `Waiting for ${device.requested_status.toLowerCase()}...`
                  : `Turn ${commandTarget.toLowerCase()}`}
            </button>
          </div>
          {commandPending && (
            <p className="command-breaker-notice" role="status" aria-live="polite">
              Waiting for the breaker to report {device.requested_status}. The
              command expires after 30 seconds if the device does not receive it.
            </p>
          )}
          {commandError && (
            <p className="delete-breaker-error" role="alert">
              Could not control breaker: {commandError}
            </p>
          )}
          {deleteError && (
            <p className="delete-breaker-error" role="alert">
              Could not delete breaker: {deleteError}
            </p>
          )}
          <div className="breaker-summary">
            <div className="breaker-icon" aria-hidden="true">✓</div>
            <div>
              <strong>{breaker.detail}</strong>
              <p className="muted-text">Last event: {breaker.lastEvent}</p>
            </div>
          </div>
          <div className="breaker-metrics">
            <div>
              <span className="metric-label">Reporting coverage (24h)</span>
              <strong>{breaker.uptime}</strong>
            </div>
            <div>
              <span className="metric-label">Reported breaker state</span>
              <strong>{breaker.status}</strong>
            </div>
            <div>
              <span className="metric-label">Last sensor reading</span>
              <strong>{formatDate(latest?.updated_at)}</strong>
            </div>
          </div>
        </section>

        <section className="chart-panel" aria-labelledby="trend-heading">
          <div className="section-title-row">
            <div>
              <p className="eyebrow">Live telemetry</p>
              <h2 id="trend-heading">Current draw trend</h2>
            </div>
            <span className="muted-text">Last 6 hours</span>
          </div>
          <div className="chart-wrap">
            <Line data={chartData} options={chartOptions} />
          </div>
        </section>

        <section className="sensor-section" aria-labelledby="sensors-heading">
          <div className="section-title-row">
            <div>
              <p className="eyebrow">Telemetry</p>
              <h2 id="sensors-heading">Sensor data</h2>
            </div>
            <span className="muted-text">
              {sensors.filter((sensor) => sensor.value !== "--" && readingFresh).length}
              {" "}reporting measurements
            </span>
          </div>
          <div className="sensor-grid">
            {sensors.map((sensor) => (
              <article className={`sensor-card sensor-card--${sensor.tone}`} key={sensor.label}>
                <div className="sensor-card__topline">
                  <span className="sensor-label">{sensor.label}</span>
                  <span className="sensor-status">{sensor.status}</span>
                </div>
                <p className="sensor-value">
                  {sensor.value}<span>{sensor.unit}</span>
                </p>
                <div className="sensor-bar" aria-hidden="true"><span /></div>
                <p className="sensor-caption">
                  {sensor.status === "No data"
                    ? "No measurement received"
                    : sensor.status === "Stale"
                      ? "Waiting for updated reading"
                      : sensor.status === "Watch"
                        ? "Above configured threshold"
                        : "Within configured threshold"}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="alerts-section" aria-labelledby="alerts-heading">
          <div className="section-title-row">
            <div>
              <p className="eyebrow">Needs attention</p>
              <h2 id="alerts-heading">Alerts</h2>
            </div>
            <span className="alert-count">{alerts.length} recent</span>
          </div>
          <div className="alerts-list">
            {alerts.length === 0 && (
              <p style={{ padding: 20 }}>No active alerts</p>
            )}
            {alerts.map((alert) => (
              <article className="alert-row" key={alert.id}>
                <span className={`alert-marker alert-marker--${alert.tone}`} aria-hidden="true" />
                <div className="alert-copy">
                  <div className="alert-title-row">
                    <h3>{alert.title}</h3>
                    <span className={`severity severity--${alert.tone}`}>
                      {alert.severity}
                    </span>
                  </div>
                  <p>{alert.detail}</p>
                </div>
                <time>{alert.time}</time>
              </article>
            ))}
          </div>
        </section>
      </main>

      {isModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => !isSaving && setIsModalOpen(false)}
        >
          <div
            className="breaker-modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-heading"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Equipment setup</p>
                <h2 id="modal-heading">Add breaker</h2>
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Close add breaker dialog"
                onClick={() => setIsModalOpen(false)}
                disabled={isSaving}
              >×</button>
            </div>
            <form className="breaker-form" onSubmit={handleAddBreaker}>
              <label>
                Device ID
                <span className="device-id-row">
                  <input
                    name="deviceId"
                    value={formData.deviceId}
                    onChange={handleFormChange}
                    placeholder="esp32-1"
                    maxLength={80}
                    required
                    autoFocus
                  />
                  <button
                    className="channel-edit-button"
                    type="button"
                    onClick={handleGenerateDeviceId}
                  >
                    Generate ID
                  </button>
                </span>
                <span className="form-hint">
                  Generate an ID or choose one; the setup screen adds it to the ESP32 config exactly.
                </span>
              </label>
              <label>
                Breaker name
                <input
                  name="name"
                  value={formData.name}
                  onChange={handleFormChange}
                  placeholder="e.g. Workshop breaker"
                  required
                />
              </label>
              <label>
                Location
                <input
                  name="location"
                  value={formData.location}
                  onChange={handleFormChange}
                  placeholder="e.g. Workshop"
                  required
                />
              </label>
              <label>
                Logical circuit/channel
                <input
                  name="channel"
                  value={formData.channel}
                  onChange={handleFormChange}
                  placeholder="e.g. Panel A / Circuit 1"
                  maxLength={80}
                  required
                />
              </label>
              <label>
                Capacity
                <span className="input-with-unit">
                  <input
                    name="capacity"
                    type="number"
                    min="0.1"
                    step="any"
                    value={formData.capacity}
                    onChange={handleFormChange}
                    placeholder="20"
                    required
                  />
                  <span>amps</span>
                </span>
              </label>
              <fieldset>
                <legend>Initial status</legend>
                <div className="status-options">
                  <label className={formData.status === "active" ? "status-option status-option--selected" : "status-option"}>
                    <input
                      type="radio"
                      name="status"
                      value="active"
                      checked={formData.status === "active"}
                      onChange={handleFormChange}
                    />
                    Active
                  </label>
                  <label className={formData.status === "inactive" ? "status-option status-option--selected" : "status-option"}>
                    <input
                      type="radio"
                      name="status"
                      value="inactive"
                      checked={formData.status === "inactive"}
                      onChange={handleFormChange}
                    />
                    Inactive
                  </label>
                </div>
                <p className="muted-text">New breakers are registered as OFF until their physical state is verified.</p>
              </fieldset>
              {formError && <p className="form-error" role="alert">{formError}</p>}
              <div className="modal-actions">
                <button
                  className="cancel-button"
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={isSaving}
                >Cancel</button>
                <button className="submit-button" type="submit" disabled={isSaving}>
                  {isSaving ? "Adding..." : "Add breaker"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default SuccessPage;
