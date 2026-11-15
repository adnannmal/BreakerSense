import { Link, useNavigate } from "react-router-dom";
import "./AccountPage.css";

function AccountPage() {
  const navigate = useNavigate();
  const email = sessionStorage.getItem("email") || "Email unavailable";
  const initials = email.charAt(0).toUpperCase();

  function handleSignOut() {
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("email");
    navigate("/", { replace: true });
  }

  return (
    <div className="account-page">
      <header className="account-header">
        <Link className="account-brand" to="/success" aria-label="BreakerSense home">
          <span className="account-brand__mark" aria-hidden="true">B</span>
          <span>BreakerSense</span>
        </Link>
        <nav className="account-nav" aria-label="Main navigation">
          <Link to="/success">Dashboard</Link>
          <span className="account-nav__current" aria-current="page">Account</span>
          <button type="button" onClick={handleSignOut}>Sign out</button>
        </nav>
      </header>

      <main className="account-content">
        <div className="account-intro">
          <p className="account-eyebrow">PERSONAL SETTINGS</p>
          <h1>Your account</h1>
          <p>Manage your sign-in details and account access.</p>
        </div>

        <section className="account-profile" aria-labelledby="profile-heading">
          <div className="account-avatar" aria-hidden="true">{initials}</div>
          <div className="account-profile__identity">
            <p className="account-eyebrow">SIGNED-IN ACCOUNT</p>
            <h2 id="profile-heading">{email}</h2>
            <span className="account-status">
              <span className="account-status__dot" aria-hidden="true" />
              Signed in
            </span>
          </div>
        </section>

        <div className="account-grid">
          <section className="account-card" aria-labelledby="details-heading">
            <div className="account-card__heading">
              <span className="account-card__icon account-card__icon--profile" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="8" r="3.25" />
                  <path d="M5.5 19c.6-3.1 2.9-4.75 6.5-4.75s5.9 1.65 6.5 4.75" />
                </svg>
              </span>
              <div>
                <h2 id="details-heading">Account details</h2>
                <p>Your sign-in information</p>
              </div>
            </div>
            <dl className="account-details">
              <div>
                <dt>Email address</dt>
                <dd>{email}</dd>
              </div>
              <div>
                <dt>Sign-in method</dt>
                <dd>Email and password</dd>
              </div>
            </dl>
          </section>

          <section className="account-card account-security" aria-labelledby="security-heading">
            <div className="account-card__heading">
              <span className="account-card__icon account-card__icon--security" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <rect x="5.25" y="10" width="13.5" height="10" rx="2" />
                  <path d="M8.25 10V7a3.75 3.75 0 0 1 7.5 0v3M12 14v2" />
                </svg>
              </span>
              <div>
                <h2 id="security-heading">Password &amp; security</h2>
                <p>Keep your account protected</p>
              </div>
            </div>
            <p className="account-security__copy">
              Need to change your password? We’ll help you securely reset it using your email.
            </p>
            <Link className="account-action" to="/forgot-password">
              Reset password <span aria-hidden="true">↗</span>
            </Link>
          </section>
        </div>

        <section className="account-footer-card" aria-labelledby="devices-heading">
          <div>
            <p className="account-eyebrow">BREAKER SENSE</p>
            <h2 id="devices-heading">Back to monitoring</h2>
            <p>Manage your registered breakers and review their latest readings.</p>
          </div>
          <Link className="account-dashboard-link" to="/success">
            Open dashboard <span aria-hidden="true">→</span>
          </Link>
        </section>

        <p className="account-signout-note">
          Not using a private device?{" "}
          <button type="button" onClick={handleSignOut}>Sign out of your account</button>
        </p>
      </main>
    </div>
  );
}

export default AccountPage;
