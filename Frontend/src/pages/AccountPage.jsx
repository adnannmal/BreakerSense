import { Link } from "react-router-dom";
import "./SuccessPage.css";
import "./SettingsPage.css";
import "./AccountPage.css";

const accountProfile = {
  name: "Jordan Miles",
  email: "jordan.miles@breakersense.com",
  role: "Operations Lead",
  company: "North Ridge Energy",
  region: "Austin, Texas",
  phone: "+1 (512) 555-0148",
  permissions: ["System overview access", "Breaker controls", "Alert acknowledgements"],
};

function AccountPage() {
  return (
    <div className="dashboard-page circuit-background account-page">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">BreakerSense / Account</p>
          <h1>Account</h1>
        </div>
        <div className="dashboard-header__actions">
          <Link className="settings-button" to="/success">Back to dashboard</Link>
        </div>
      </header>

      <main className="dashboard-content settings-content">
        <div className="account-layout">
          <section className="account-panel account-panel--highlight" aria-labelledby="account-profile-heading">
            <div className="account-avatar" aria-hidden="true">
              {accountProfile.name
                .split(" ")
                .map((part) => part[0])
                .slice(0, 2)
                .join("")}
            </div>
            <div className="account-summary">
              <p className="eyebrow">Profile</p>
              <h2 id="account-profile-heading">{accountProfile.name}</h2>
              <p className="account-role">{accountProfile.role}</p>
              <ul className="account-metadata">
                <li>
                  <span>Email</span>
                  <strong>{accountProfile.email}</strong>
                </li>
                <li>
                  <span>Company</span>
                  <strong>{accountProfile.company}</strong>
                </li>
                <li>
                  <span>Region</span>
                  <strong>{accountProfile.region}</strong>
                </li>
                <li>
                  <span>Phone</span>
                  <strong>{accountProfile.phone}</strong>
                </li>
              </ul>
            </div>
          </section>

          <section className="account-panel" aria-labelledby="account-access-heading">
            <div className="account-panel__header">
              <div>
                <p className="eyebrow">Access</p>
                <h2 id="account-access-heading">Permissions</h2>
              </div>
              <span className="account-status">Connected</span>
            </div>

            <ul className="account-permissions">
              {accountProfile.permissions.map((permission) => (
                <li key={permission}>{permission}</li>
              ))}
            </ul>

            <div className="account-actions">
              <button className="cancel-button" type="button">Edit profile</button>
              <button className="submit-button" type="button">Manage access</button>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export default AccountPage;
