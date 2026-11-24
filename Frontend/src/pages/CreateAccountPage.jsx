import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { api } from "../api";
import "./AuthPage.css";

function CreateAccountPage() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister(e) {
    e.preventDefault();

    setError("");
    setLoading(true);

    try {
      const data = await api.register(
        email.trim(),
        password
      );

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
        <form className="auth-card" onSubmit={handleRegister} aria-busy={loading}>
          <h1>Create account</h1>

          <label className="auth-field" htmlFor="register-email">
            Email
            <input
              id="register-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>

          <label className="auth-field" htmlFor="register-password">
            Password
            <input
              id="register-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={6}
              required
            />
          </label>

          {error && <p className="auth-message auth-message--error" role="alert">{error}</p>}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? "Creating account..." : "Create account"}
          </button>

          <p className="auth-links">
            Already have an account?{" "}
            <Link to="/" viewTransition>Back to sign in</Link>
          </p>
        </form>
      </main>
    </div>
  );
}

export default CreateAccountPage;