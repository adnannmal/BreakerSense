import { Link } from "react-router-dom";
import { useState } from "react";
import { api } from "../api";

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
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.logo}>BreakerSense</h1>
      </header>

      <main style={styles.main}>
        <form style={styles.form} onSubmit={handleSubmit}>
          <h2>Forgot password?</h2>
          <p style={styles.text}>Enter your account email and we’ll send a reset link if an account exists.</p>

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={styles.input}
            autoComplete="email"
            required
          />

          {error && <p style={styles.error}>{error}</p>}
          {message && <p style={styles.success} role="status">{message}</p>}

          <button style={styles.button} type="submit" disabled={loading}>
            {loading ? "Sending..." : "Send reset link"}
          </button>

          <p style={styles.text}>
            <Link to="/">Back to login</Link>
          </p>
        </form>
      </main>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    backgroundColor: "#f4f6f8",
    fontFamily: "Arial",
  },
  header: {
    backgroundColor: "#1f2937",
    padding: "20px",
    textAlign: "center",
  },
  logo: {
    color: "white",
    margin: 0,
  },
  main: {
    display: "flex",
    justifyContent: "center",
    marginTop: "80px",
  },
  form: {
    backgroundColor: "white",
    padding: "30px",
    borderRadius: "10px",
    width: "320px",
    display: "flex",
    flexDirection: "column",
    gap: "15px",
  },
  input: {
    padding: "12px",
    fontSize: "16px",
  },
  button: {
    padding: "12px",
    backgroundColor: "#2563eb",
    color: "white",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  },
  text: {
    textAlign: "center",
    fontSize: "14px",
    margin: 0,
  },
  error: {
    color: "red",
    margin: 0,
    fontSize: "14px",
  },
  success: {
    color: "#166534",
    margin: 0,
    fontSize: "14px",
  },
};

export default ForgotPasswordPage;
