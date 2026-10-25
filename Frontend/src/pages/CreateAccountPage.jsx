import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { api } from "../api";

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

      navigate("/success");
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
        <form style={styles.form} onSubmit={handleRegister}>
          <h2>Create Account</h2>

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={styles.input}
            required
          />

          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            minLength={6}
            required
          />

          {error && (
            <p style={{ color: "red", fontSize: "14px" }}>
              {error}
            </p>
          )}

          <button
            style={styles.button}
            type="submit"
            disabled={loading}
          >
            {loading ? "Creating Account..." : "Create Account"}
          </button>

          <p style={styles.text}>
            Already have an account?{" "}
            <Link to="/">
              Back to Login
            </Link>
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
  },

  text: {
    textAlign: "center",
    fontSize: "14px",
  },
};

export default CreateAccountPage;