import { useState } from "react";
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
import "./SuccessPage.css";

ChartJS.register(CategoryScale, Filler, LinearScale, LineElement, PointElement, Tooltip);

const mockDashboard = {
  updatedAt: "Just now",
  breaker: {
    name: "Main breaker",
    location: "Panel A / Line 01",
    status: "Healthy",
    detail: "No trip conditions detected",
    uptime: "99.98%",
    lastEvent: "No events in the last 24 hours",
  },
  sensors: [
    { label: "Voltage", value: "237", unit: "V", status: "Normal", tone: "blue" },
    { label: "Current", value: "18.4", unit: "A", status: "Normal", tone: "teal" },
    { label: "Temperature", value: "42", unit: "°C", status: "Watch", tone: "amber" },
  ],
  alerts: [
    {
      title: "Temperature approaching threshold",
      detail: "Main breaker sensor is above its usual operating range.",
      time: "12 minutes ago",
      severity: "Medium",
      tone: "amber",
    },
    {
      title: "Routine sensor check completed",
      detail: "All connected sensors reported successfully.",
      time: "1 hour ago",
      severity: "Info",
      tone: "blue",
    },
  ],
};

function SuccessPage() {
  const [breaker, setBreaker] = useState(mockDashboard.breaker);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    location: "",
    capacity: "",
    status: "active",
  });
  const [formError, setFormError] = useState("");
  const { sensors, alerts, updatedAt } = mockDashboard;

  const chartData = {
    labels: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"],
    datasets: [{
      label: "Current draw",
      data: [14.2, 16.8, 15.4, 19.1, 17.6, 18.4],
      borderColor: "#1b9586",
      backgroundColor: "rgba(27, 149, 134, 0.12)",
      fill: true,
      tension: 0.35,
      pointRadius: 3,
      pointBackgroundColor: "#1b9586",
    }],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { displayColors: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: "#718087" } },
      y: { border: { display: false }, grid: { color: "#e8efed" }, ticks: { color: "#718087" } },
    },
  };

  function handleFormChange(event) {
    const { name, value } = event.target;
    setFormData((current) => ({ ...current, [name]: value }));
  }

  function handleAddBreaker(event) {
    event.preventDefault();

    if (!formData.name.trim() || !formData.location.trim() || !formData.capacity) {
      setFormError("Complete all fields before adding the breaker.");
      return;
    }

    const isActive = formData.status === "active";
    setBreaker({
      name: formData.name.trim(),
      location: formData.location.trim(),
      status: isActive ? "Active" : "Inactive",
      detail: isActive ? "Breaker is online and monitoring normally" : "Monitoring is currently paused",
      uptime: "New",
      lastEvent: "Added just now",
    });
    setFormData({ name: "", location: "", capacity: "", status: "active" });
    setFormError("");
    setIsModalOpen(false);
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">BreakerSense / Operations</p>
          <h1>System overview</h1>
        </div>
        <div className="dashboard-header__actions">
          <button className="add-breaker-button" type="button" onClick={() => setIsModalOpen(true)}>
            <span aria-hidden="true">+</span>
            Add breaker
          </button>
          <div className="connection-status">
            <span className="connection-dot" aria-hidden="true" />
            <span>Live monitor</span>
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
            <span className="status-pill status-pill--healthy">
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
              <span className="metric-label">Uptime</span>
              <strong>{breaker.uptime}</strong>
            </div>
            <div>
              <span className="metric-label">Operating mode</span>
              <strong>Automatic</strong>
            </div>
            <div>
              <span className="metric-label">Last inspection</span>
              <strong>Today, 09:42</strong>
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
            <span className="muted-text">3 connected sensors</span>
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
                <p className="sensor-caption">Within expected range</p>
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
            {alerts.map((alert) => (
              <article className="alert-row" key={alert.title}>
                <span className={`alert-marker alert-marker--${alert.tone}`} aria-hidden="true" />
                <div className="alert-copy">
                  <div className="alert-title-row">
                    <h3>{alert.title}</h3>
                    <span className={`severity severity--${alert.tone}`}>{alert.severity}</span>
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
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setIsModalOpen(false)}>
          <div className="breaker-modal" role="dialog" aria-modal="true" aria-labelledby="modal-heading" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">Equipment setup</p>
                <h2 id="modal-heading">Add breaker</h2>
              </div>
              <button className="modal-close" type="button" aria-label="Close add breaker dialog" onClick={() => setIsModalOpen(false)}>×</button>
            </div>
            <form className="breaker-form" onSubmit={handleAddBreaker}>
              <label>
                Breaker name
                <input name="name" value={formData.name} onChange={handleFormChange} placeholder="e.g. Workshop breaker" autoFocus />
              </label>
              <label>
                Location
                <input name="location" value={formData.location} onChange={handleFormChange} placeholder="e.g. Panel B / Line 02" />
              </label>
              <label>
                Capacity
                <span className="input-with-unit">
                  <input name="capacity" type="number" min="1" max="10000" value={formData.capacity} onChange={handleFormChange} placeholder="100" />
                  <span>amps</span>
                </span>
              </label>
              <fieldset>
                <legend>Initial status</legend>
                <div className="status-options">
                  <label className={formData.status === "active" ? "status-option status-option--selected" : "status-option"}>
                    <input type="radio" name="status" value="active" checked={formData.status === "active"} onChange={handleFormChange} />
                    Active
                  </label>
                  <label className={formData.status === "inactive" ? "status-option status-option--selected" : "status-option"}>
                    <input type="radio" name="status" value="inactive" checked={formData.status === "inactive"} onChange={handleFormChange} />
                    Inactive
                  </label>
                </div>
              </fieldset>
              {formError && <p className="form-error" role="alert">{formError}</p>}
              <div className="modal-actions">
                <button className="cancel-button" type="button" onClick={() => setIsModalOpen(false)}>Cancel</button>
                <button className="submit-button" type="submit">Add breaker</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default SuccessPage;