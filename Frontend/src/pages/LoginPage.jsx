import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";

function LoginPage() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const mockUser = {
    email: "test@breakersense.com",
    password: "password123",
  };

  function handleLogin(e) {
    e.preventDefault();

    if (
      email === mockUser.email &&
      password === mockUser.password
    ) {
      setError("");

      navigate("/success");
    } else {
      setError("Invalid email or password");
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.logo}>BreakerSense</h1>
      </header>

      <main style={styles.main}>
        <form style={styles.form} onSubmit={handleLogin}>
          <h2>Login</h2>

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) =>
              setEmail(e.target.value)
            }
            style={styles.input}
          />

          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) =>
              setPassword(e.target.value)
            }
            style={styles.input}
          />

          {error && (
            <p style={styles.error}>
              {error}
            </p>
          )}

          <button style={styles.button}>
            Sign In
          </button>

          <p style={styles.text}>
            Don’t have an account?{" "}
            <Link to="/create-account">
              Create one
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

  error: {
    color: "red",
    margin: 0,
    fontSize: "14px",
  },
};

export default LoginPage;