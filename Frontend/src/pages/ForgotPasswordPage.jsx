import { Link } from "react-router-dom";
import { useState } from "react";
import { api } from "../api";
import "./AuthPage.css";

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const data = await api.forgotPassword(email.trim());
      setMessage(data.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <header className="auth-header">
        <Link className="auth-brand" to="/" viewTransition aria-label="BreakerSense home">
          <span className="auth-brand__mark" aria-hidden="true">B</span>
          <span>BreakerSense</span>
        </Link>
      </header>

      <main className="auth-main">
        <form className="auth-card" onSubmit={handleSubmit} aria-busy={loading}>
          <h1>Forgot password?</h1>
          <p className="auth-description">Enter your account email and we’ll send a reset link if an account exists.</p>

          <label className="auth-field" htmlFor="forgot-email">
            Email
            <input
              id="forgot-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>

          {error && <p className="auth-message auth-message--error" role="alert">{error}</p>}
          {message && <p className="auth-message auth-message--success" role="status">{message}</p>}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? "Sending..." : "Send reset link"}
          </button>

          <p className="auth-links">
            <Link to="/" viewTransition>Back to login</Link>
          </p>
        </form>
      </main>
    </div>
  );
}

export default ForgotPasswordPage;
