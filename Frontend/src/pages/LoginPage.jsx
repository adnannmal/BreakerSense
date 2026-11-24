import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { api } from "../api";
import "./AuthPage.css";

function LoginPage() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();

    setError("");
    setLoading(true);

    try {
      const data = await api.login(email.trim(), password);

      sessionStorage.setItem("token", data.token);
      sessionStorage.setItem("email", data.email);

      navigate("/success", { viewTransition: true });
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
        <form className="auth-card" onSubmit={handleLogin} aria-busy={loading}>
          <h1>Sign in</h1>

          <label className="auth-field" htmlFor="login-email">
            Email
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>

          <label className="auth-field" htmlFor="login-password">
            Password
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          {error && <p className="auth-message auth-message--error" role="alert">{error}</p>}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </button>

          <div className="auth-links">
            <p><Link to="/forgot-password" viewTransition>Forgot password?</Link></p>
            <p>
              Don’t have an account?{" "}
              <Link to="/create-account" viewTransition>Create one</Link>
            </p>
          </div>
        </form>
      </main>
    </div>
  );
}

export default LoginPage;