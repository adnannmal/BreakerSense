import { useState } from "react";
import { Link } from "react-router-dom";
import "./SuccessPage.css";
import "./SettingsPage.css";

function SettingsPage() {
  const [temperatureUnit, setTemperatureUnit] = useState("celsius");
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [saved, setSaved] = useState(false);

  function handleSubmit(event) {
    event.preventDefault();
    setSaved(true);
  }

  return (
    <div className="dashboard-page circuit-background settings-page">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">BreakerSense / Preferences</p>
          <h1>Settings</h1>
        </div>
        <div className="dashboard-header__actions">
          <Link className="settings-button" to="/success">Back to dashboard</Link>
        </div>
      </header>

      <main className="dashboard-content settings-content">
        <form className="settings-panel" onSubmit={handleSubmit}>
          <section className="settings-section" aria-labelledby="display-settings-heading">
            <div>
              <p className="eyebrow">Dashboard</p>
              <h2 id="display-settings-heading">Display preferences</h2>
              <p className="settings-description">Choose how sensor readings appear.</p>
            </div>
            <label className="settings-control" htmlFor="temperature-unit">
              Temperature unit
              <select
                id="temperature-unit"
                value={temperatureUnit}
                onChange={(event) => {
                  setTemperatureUnit(event.target.value);
                  setSaved(false);
                }}
              >
                <option value="celsius">Celsius (°C)</option>
                <option value="fahrenheit">Fahrenheit (°F)</option>
              </select>
            </label>
          </section>

          <section className="settings-section" aria-labelledby="notification-settings-heading">
            <div>
              <p className="eyebrow">Alerts</p>
              <h2 id="notification-settings-heading">Notifications</h2>
              <p className="settings-description">Choose which updates you receive.</p>
            </div>
            <label className="settings-toggle">
              <span>
                <strong>Email alerts</strong>
                <span>Receive an email when a breaker needs attention.</span>
              </span>
              <input
                type="checkbox"
                checked={emailAlerts}
                onChange={(event) => {
                  setEmailAlerts(event.target.checked);
                  setSaved(false);
                }}
              />
            </label>
          </section>

          <div className="settings-actions">
            {saved && <p className="settings-saved" role="status">Preferences saved for this session.</p>}
            <button className="submit-button" type="submit">Save preferences</button>
          </div>
        </form>
      </main>
    </div>
  );
}

export default SettingsPage;