
import { useEffect, useState } from "react";
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
  capacity: "",
  status: "inactive",
};

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
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState("");
  const [lastFetchedAt, setLastFetchedAt] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadDevices() {
      try {
        const result = await api.getDevices();
        if (!active) return;
        const list = Array.isArray(result) ? result : [];
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
    if (!selectedDeviceId) {
      setDashboard(null);
      return;
    }

    let active = true;
    let inFlight = false;

    async function loadDashboard() {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await api.getDashboard(selectedDeviceId);
        if (!active) return;
        setDashboard(result);
        setLastFetchedAt(new Date());
        setDataError("");
      } catch (err) {
        if (active) {
          setDataError(err.message);
          setDashboard(null);
        }
      } finally {
        inFlight = false;
      }
    }

    setDashboard(null);
    setLastFetchedAt(null);
    loadDashboard();
    const interval = setInterval(loadDashboard, 3000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedDeviceId]);

  const device = dashboard?.device;
  const latest = dashboard?.latest;
  const updatedAt = lastFetchedAt ? lastFetchedAt.toLocaleTimeString() : "Never";
  const readingAge = latest?.updated_at
    ? Date.now() - new Date(latest.updated_at).getTime()
    : null;
  const readingFresh =
    readingAge !== null && readingAge >= 0 && readingAge < 15000;

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
    makeSensor("Current", latest?.current, "A", device?.current_threshold, "teal"),
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
        borderColor: "#1b9586",
        backgroundColor: "rgba(27, 149, 134, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: "#1b9586",
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { displayColors: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: "#718087" } },
      y: {
        border: { display: false },
        grid: { color: "#e8efed" },
        ticks: { color: "#718087" },
      },
    },
  };

  function handleFormChange(event) {
    const { name, value } = event.target;
    setFormData((current) => ({ ...current, [name]: value }));
  }

  async function handleAddBreaker(event) {
    event.preventDefault();
    if (isSaving) return;
    if (
      !formData.deviceId.trim() ||
      !formData.name.trim() ||
      !formData.location.trim() ||
      !formData.capacity ||
      !Number.isFinite(Number(formData.capacity)) ||
      Number(formData.capacity) <= 0
    ) {
      setFormError("Complete all fields with a valid positive capacity.");
      return;
    }

    setFormError("");
    setIsSaving(true);
    try {
      const newDevice = await api.addDevice({
        device_id: formData.deviceId.trim(),
        nickname: formData.name.trim(),
        location: formData.location.trim(),
        capacity_amps: Number(formData.capacity),
        status: "OFF",
      });
      const updatedDevices = await api.getDevices();
      setDevices(updatedDevices);
      setSelectedDeviceId(newDevice.device_id);
      setFormData({ ...EMPTY_FORM });
      setIsModalOpen(false);
      setDataError("");
    } catch (err) {
      setFormError(err.message);
    } finally {
      setIsSaving(false);
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
      {!loading && !dataError && devices.length === 0 && (
        <p>No breakers registered yet. Click Add breaker to begin.</p>
      )}

      <header className="dashboard-header">
        <div>
          <p className="eyebrow">BreakerSense / Operations</p>
          <h1>System overview</h1>
        </div>
        <div className="dashboard-header__actions">
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
              style={{ backgroundColor: readingFresh ? "#24a18f" : "#94a3b8" }}
            />
            <span>{readingFresh ? "Live monitor" : "Waiting for device"}</span>
            <span className="updated-time">Updated {updatedAt}</span>
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
            <span className="status-pill">
              <span className="status-dot" aria-hidden="true" />
              {breaker.status}
            </span>
          </div>
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
              <span className="metric-label">Recorded breaker state</span>
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

        <section aria-labelledby="sensors-heading">
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
                <input
                  name="deviceId"
                  value={formData.deviceId}
                  onChange={handleFormChange}
                  placeholder="esp32-1"
                  required
                  autoFocus
                />
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
                  placeholder="e.g. Panel B / Line 02"
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
