import { Link, useSearchParams } from "react-router-dom";
import { useState } from "react";
import { api } from "../api";
import "./AuthPage.css";

function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const data = await api.resetPassword(token, password);
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
          <h1>Reset password</h1>

          {!token ? (
            <p className="auth-message auth-message--error" role="alert">This password reset link is invalid or has expired.</p>
          ) : message ? (
            <>
              <p className="auth-message auth-message--success" role="status">{message}</p>
              <Link to="/" viewTransition>Back to login</Link>
            </>
          ) : (
            <>
              <label className="auth-field" htmlFor="reset-password">
                New password
                <input
                  id="reset-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={6}
                  required
                />
              </label>

              <label className="auth-field" htmlFor="confirm-reset-password">
                Confirm new password
                <input
                  id="confirm-reset-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={6}
                  required
                />
              </label>

              {error && <p className="auth-message auth-message--error" role="alert">{error}</p>}

              <button className="auth-submit" type="submit" disabled={loading}>
                {loading ? "Saving..." : "Save new password"}
              </button>
            </>
          )}

          {!message && (
            <p className="auth-links">
              <Link to="/" viewTransition>Back to login</Link>
            </p>
          )}
        </form>
      </main>
    </div>
  );
}

export default ResetPasswordPage;
