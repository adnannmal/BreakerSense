import { useEffect, useRef, useState } from "react";
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
import "./SuccessPage.css";

ChartJS.register(CategoryScale, Filler, LinearScale, LineElement, PointElement, Tooltip);

function createNetworkAlert(isOnline) {
  return {
    id: `network-${isOnline ? "restored" : "lost"}-${Date.now()}`,
    title: isOnline ? "Network connection restored" : "Network connection lost",
    detail: isOnline
      ? "The browser is back online. Live monitoring can resume."
      : "The browser is offline. Live monitoring may not receive new readings.",
    time: "Just now",
    severity: isOnline ? "Info" : "Warning",
    tone: isOnline ? "blue" : "amber",
  };
}

const mockDashboard = {
  updatedAt: "Just now",
  breakers: [
    {
      id: "main",
      name: "Main breaker",
      location: "Panel A / Line 01",
      status: "Healthy",
      detail: "No trip conditions detected",
      uptime: "99.98%",
      lastEvent: "No events in the last 24 hours",
      history: [
        { kind: "Log", title: "Routine inspection completed", detail: "All breaker checks passed.", time: "Today, 09:42", tone: "blue" },
        { kind: "Alert", title: "Temperature approaching threshold", detail: "Main breaker sensor was above its usual operating range.", time: "Yesterday, 16:18", tone: "amber" },
        { kind: "Log", title: "Breaker connected", detail: "Monitoring started for Panel A / Line 01.", time: "Sep 24, 08:30", tone: "blue" },
      ],
    },
    {
      id: "workshop",
      name: "Workshop breaker",
      location: "Panel A / Line 02",
      connectionStatus: "Disconnected",
      status: "Healthy",
      detail: "Breaker connection was lost; readings may be stale",
      uptime: "99.94%",
      lastEvent: "No events in the last 24 hours",
      history: [
        { kind: "Log", title: "Routine inspection completed", detail: "Voltage and current readings were within range.", time: "Today, 08:55", tone: "blue" },
        { kind: "Log", title: "Load test completed", detail: "Workshop circuit passed its scheduled load test.", time: "Sep 27, 14:10", tone: "blue" },
      ],
    },
    {
      id: "hvac",
      name: "HVAC breaker",
      location: "Panel B / Line 01",
      status: "Watch",
      detail: "Temperature is approaching its usual operating range",
      uptime: "99.87%",
      lastEvent: "Temperature alert 12 minutes ago",
      history: [
        { kind: "Alert", title: "Temperature approaching threshold", detail: "HVAC breaker temperature is above its typical range.", time: "12 minutes ago", tone: "amber" },
        { kind: "Log", title: "Routine sensor check completed", detail: "All connected sensors reported successfully.", time: "1 hour ago", tone: "blue" },
        { kind: "Log", title: "Maintenance inspection completed", detail: "No physical issues found during inspection.", time: "Sep 25, 11:20", tone: "blue" },
      ],
    },
  ],
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
      severity: "Warning",
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
  const [breakers, setBreakers] = useState(mockDashboard.breakers);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [alerts, setAlerts] = useState(() => (
    navigator.onLine ? mockDashboard.alerts : [createNetworkAlert(false), ...mockDashboard.alerts]
  ));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [resetTargetId, setResetTargetId] = useState(null);
  const [openPowerId, setOpenPowerId] = useState(null);
  const powerControlRef = useRef(null);
  const [openHistoryId, setOpenHistoryId] = useState(null);
  const historyControlRef = useRef(null);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const notificationControlRef = useRef(null);
  const notificationButtonRef = useRef(null);
  const [formData, setFormData] = useState({
    name: "",
    location: "",
    capacity: "",
    status: "active",
  });
  const [formError, setFormError] = useState("");
  const { sensors, updatedAt } = mockDashboard;
  const warningCount = alerts.filter((alert) => alert.severity === "Warning").length;

  useEffect(() => {
    function handleOffline() {
      setIsOnline(false);
      setAlerts((current) => [createNetworkAlert(false), ...current]);
    }

    function handleOnline() {
      setIsOnline(true);
      setAlerts((current) => [createNetworkAlert(true), ...current]);
    }

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  useEffect(() => {
    if (!isNotificationsOpen) return undefined;

    function handleOutsideClick(event) {
      if (!notificationControlRef.current?.contains(event.target)) {
        setIsNotificationsOpen(false);
      }
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsNotificationsOpen(false);
        notificationButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isNotificationsOpen]);

  useEffect(() => {
    if (!openHistoryId) return undefined;

    function handleHistoryOutsideClick(event) {
      if (!historyControlRef.current?.contains(event.target)) {
        setOpenHistoryId(null);
      }
    }

    function handleHistoryEscape(event) {
      if (event.key === "Escape") {
        setOpenHistoryId(null);
        historyControlRef.current?.querySelector("button")?.focus();
      }
    }

    document.addEventListener("pointerdown", handleHistoryOutsideClick);
    document.addEventListener("keydown", handleHistoryEscape);
    return () => {
      document.removeEventListener("pointerdown", handleHistoryOutsideClick);
      document.removeEventListener("keydown", handleHistoryEscape);
    };
  }, [openHistoryId]);

  useEffect(() => {
    if (!openPowerId) return undefined;

    function handlePowerMenuOutsideClick(event) {
      if (!powerControlRef.current?.contains(event.target)) {
        setOpenPowerId(null);
      }
    }

    function handlePowerMenuEscape(event) {
      if (event.key === "Escape") {
        setOpenPowerId(null);
        powerControlRef.current?.querySelector("button")?.focus();
      }
    }

    document.addEventListener("pointerdown", handlePowerMenuOutsideClick);
    document.addEventListener("keydown", handlePowerMenuEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePowerMenuOutsideClick);
      document.removeEventListener("keydown", handlePowerMenuEscape);
    };
  }, [openPowerId]);

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

  const temperatureData = {
    labels: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"],
    datasets: [
      {
        label: "Temperature",
        data: [38, 40, 41, 45, 43, 42],
        borderColor: "#d99432",
        backgroundColor: "rgba(217, 148, 50, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: "#d99432",
      },
      {
        label: "Warning threshold",
        data: [55, 55, 55, 55, 55, 55],
        borderColor: "rgba(181, 71, 53, 0.65)",
        borderDash: [5, 5],
        borderWidth: 1,
        pointRadius: 0,
      },
    ],
  };

  const temperatureOptions = {
    ...chartOptions,
    scales: {
      ...chartOptions.scales,
      y: {
        ...chartOptions.scales.y,
        min: 30,
        max: 60,
        ticks: { color: "#718087", callback: (value) => `${value}°C` },
      },
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
    setBreakers((current) => [...current, {
      id: `breaker-${Date.now()}`,
      name: formData.name.trim(),
      location: formData.location.trim(),
      connectionStatus: "Connected",
      status: isActive ? "Active" : "Inactive",
      detail: isActive ? "Breaker is online and monitoring normally" : "Monitoring is currently paused",
      uptime: "New",
      lastEvent: "Added just now",
      history: [{ kind: "Log", title: "Breaker added", detail: "Breaker was added to dashboard monitoring.", time: "Just now", tone: "blue" }],
    }]);
    setFormData({ name: "", location: "", capacity: "", status: "active" });
    setFormError("");
    setIsModalOpen(false);
  }

  function handleReconnectBreaker(breakerId) {
    setBreakers((current) => current.map((breaker) => breaker.id === breakerId
      ? {
        ...breaker,
        connectionStatus: "Connected",
        detail: "Connection restored; monitoring normally",
        lastEvent: "Reconnected just now",
        history: [
          { kind: "Log", title: "Breaker reconnected", detail: "Connection was restored from the dashboard.", time: "Just now", tone: "blue" },
          ...breaker.history,
        ],
      }
      : breaker));
  }

  function handleResetBreaker() {
    setBreakers((current) => current.map((breaker) => breaker.id === resetTargetId
      ? {
        ...breaker,
        status: "Healthy",
        detail: "Reset complete; breaker is monitoring normally",
        uptime: "Just reset",
        lastEvent: "Reset just now",
        history: [
          { kind: "Log", title: "Breaker reset", detail: "Breaker reset was confirmed and monitoring restarted.", time: "Just now", tone: "blue" },
          ...breaker.history,
        ],
      }
      : breaker));
    setResetTargetId(null);
  }

  function handleToggleBreakerPower(breaker) {
    const isPoweredOn = !["Off", "Inactive"].includes(breaker.status);
    const nextStatus = isPoweredOn ? "Off" : "Healthy";
    const action = isPoweredOn ? "turned off" : "turned on";

    setBreakers((current) => current.map((currentBreaker) => currentBreaker.id === breaker.id
      ? {
        ...currentBreaker,
        status: nextStatus,
        detail: isPoweredOn ? "Breaker is powered off; monitoring is paused" : "Breaker is powered on and monitoring normally",
        lastEvent: `Turned ${isPoweredOn ? "off" : "on"} just now`,
        history: [
          { kind: "Log", title: `Breaker ${action}`, detail: `Power was ${action} from the dashboard.`, time: "Just now", tone: "blue" },
          ...currentBreaker.history,
        ],
      }
      : currentBreaker));
    setOpenPowerId(null);
  }

  const resetTarget = breakers.find((breaker) => breaker.id === resetTargetId);

  return (
    <div className="dashboard-page circuit-background">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">BreakerSense / Operations</p>
          <h1>System overview</h1>
        </div>
        <div className="dashboard-header__actions">
          <div className="notification-control" ref={notificationControlRef}>
            <button
              ref={notificationButtonRef}
              className="notifications-button"
              type="button"
              aria-expanded={isNotificationsOpen}
              aria-controls="dashboard-notifications"
              aria-label={`Notifications, ${warningCount} warning${warningCount === 1 ? "" : "s"}`}
              onClick={() => setIsNotificationsOpen((open) => !open)}
            >
              <span aria-hidden="true">◉</span>
              Notifications
              {warningCount > 0 && <span className="notification-count">{warningCount}</span>}
            </button>
            {isNotificationsOpen && (
              <section
                className="notifications-dropdown"
                id="dashboard-notifications"
                aria-label="Recent notifications"
              >
                <div className="notifications-dropdown__heading">
                  <h2>Notifications</h2>
                  <span>{alerts.length} recent</span>
                </div>
                <ul className="notifications-list">
                  {alerts.map((alert) => (
                    <li className={`notification-item notification-item--${alert.tone}`} key={alert.id ?? `${alert.title}-${alert.time}`}>
                      <span className="notification-item__marker" aria-hidden="true" />
                      <div>
                        <div className="notification-item__title">
                          <strong>{alert.title}</strong>
                          <span className={`severity severity--${alert.tone}`}>{alert.severity}</span>
                        </div>
                        <p>{alert.detail}</p>
                        <time>{alert.time}</time>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <Link className="dashboard-account-button" to="/account">
            Account
          </Link>
          <Link className="dashboard-settings-button" to="/settings">
            Settings
          </Link>
          <button className="add-breaker-button" type="button" onClick={() => setIsModalOpen(true)}>
            <span aria-hidden="true">+</span>
            Add breaker
          </button>
          <div className={`connection-status${isOnline ? "" : " connection-status--offline"}`} role="status" aria-live="polite">
            <span className="connection-dot" aria-hidden="true" />
            <span>{isOnline ? "Live monitor" : "Connection lost"}</span>
            <span className="updated-time">Updated {updatedAt}</span>
          </div>
        </div>
      </header>

      <main className="dashboard-content">
        {breakers.map((breaker) => (
          <section className="breaker-card" aria-labelledby={`breaker-heading-${breaker.id}`} key={breaker.id}>
            <div className="section-heading">
              <div>
                <p className="eyebrow">Circuit breaker status</p>
                <h2 id={`breaker-heading-${breaker.id}`}>{breaker.name}</h2>
                <p className="muted-text">{breaker.location}</p>
              </div>
              <div className="breaker-card__actions">
                <span className={`status-pill ${breaker.status === "Healthy" ? "status-pill--healthy" : "status-pill--watch"}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {breaker.status}
                </span>
                {breaker.connectionStatus === "Disconnected" && (
                  <>
                    <span className="status-pill status-pill--offline">Connection lost</span>
                    <button className="reconnect-button" type="button" onClick={() => handleReconnectBreaker(breaker.id)}>
                      Reconnect
                    </button>
                  </>
                )}
                <div className="breaker-power-control" ref={openPowerId === breaker.id ? powerControlRef : null}>
                  <button
                    className="breaker-power-button"
                    type="button"
                    aria-label={`${breaker.name} power actions`}
                    aria-haspopup="menu"
                    aria-expanded={openPowerId === breaker.id}
                    aria-controls={`breaker-power-menu-${breaker.id}`}
                    title={`${breaker.name} power actions`}
                    onClick={(event) => {
                      powerControlRef.current = event.currentTarget.parentElement;
                      setOpenPowerId((current) => current === breaker.id ? null : breaker.id);
                    }}
                  >
                    <span aria-hidden="true">⏻</span>
                  </button>
                  {openPowerId === breaker.id && (
                    <div className="breaker-power-menu" id={`breaker-power-menu-${breaker.id}`} role="menu" aria-label={`${breaker.name} power actions`}>
                      <button type="button" role="menuitem" onClick={() => {
                        setResetTargetId(breaker.id);
                        setOpenPowerId(null);
                      }}>
                        Reset breaker
                      </button>
                      <button type="button" role="menuitem" onClick={() => handleToggleBreakerPower(breaker)}>
                        { ["Off", "Inactive"].includes(breaker.status) ? "Turn on" : "Turn off" }
                      </button>
                    </div>
                  )}
                </div>
                <div className="breaker-history-control" ref={openHistoryId === breaker.id ? historyControlRef : null}>
                  <button
                    className="history-button"
                    type="button"
                    aria-expanded={openHistoryId === breaker.id}
                    aria-controls={`breaker-history-${breaker.id}`}
                    onClick={(event) => {
                      historyControlRef.current = event.currentTarget.parentElement;
                      setOpenHistoryId((current) => current === breaker.id ? null : breaker.id);
                    }}
                  >
                    History
                  </button>
                  {openHistoryId === breaker.id && (
                    <section className="breaker-history-dropdown" id={`breaker-history-${breaker.id}`} aria-label={`${breaker.name} history`}>
                      <div className="breaker-history-dropdown__heading">
                        <h3>{breaker.name} history</h3>
                        <span>{breaker.history.length} entries</span>
                      </div>
                      {breaker.history.length > 0 ? (
                        <ul className="breaker-history-list">
                          {breaker.history.map((entry, index) => (
                            <li className={`breaker-history-entry breaker-history-entry--${entry.tone}`} key={`${entry.title}-${entry.time}-${index}`}>
                              <span className="breaker-history-entry__marker" aria-hidden="true" />
                              <div>
                                <div className="breaker-history-entry__title">
                                  <strong>{entry.title}</strong>
                                  <span>{entry.kind}</span>
                                </div>
                                <p>{entry.detail}</p>
                                <time>{entry.time}</time>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="breaker-history-empty">No history recorded for this breaker.</p>
                      )}
                    </section>
                  )}
                </div>
              </div>
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
        ))}

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

        <section className="chart-panel" aria-labelledby="temperature-heading">
          <div className="section-title-row">
            <div>
              <p className="eyebrow">Thermal telemetry</p>
              <h2 id="temperature-heading">Temperature trend</h2>
            </div>
            <span className="muted-text">Warning at 55°C</span>
          </div>
          <div className="chart-wrap">
            <Line data={temperatureData} options={temperatureOptions} />
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
          <div className="alerts-list alert-timeline">
            {alerts.map((alert) => (
              <article className="alert-row" key={alert.id ?? `${alert.title}-${alert.time}`}>
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

      {resetTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setResetTargetId(null)}>
          <div className="breaker-modal reset-modal" role="alertdialog" aria-modal="true" aria-labelledby="reset-modal-heading" aria-describedby="reset-modal-description" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">Confirm action</p>
                <h2 id="reset-modal-heading">Reset {resetTarget.name}?</h2>
              </div>
              <button className="modal-close" type="button" aria-label="Close reset confirmation" onClick={() => setResetTargetId(null)}>×</button>
            </div>
            <p className="reset-modal__description" id="reset-modal-description">
              This will clear the breaker’s current status and restart monitoring. Confirm only if it is safe to reset.
            </p>
            <div className="modal-actions">
              <button className="cancel-button" type="button" onClick={() => setResetTargetId(null)}>Cancel</button>
              <button className="reset-confirm-button" type="button" onClick={handleResetBreaker}>Confirm reset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SuccessPage;