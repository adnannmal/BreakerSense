import { Link } from "react-router-dom";

function CreateAccountPage() {
  return (
    <div className="circuit-background" style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.logo}>BreakerSense</h1>
      </header>

      <main style={styles.main}>
        <div style={styles.form}>
          <h2>Create Account</h2>

          <input
            placeholder="Email"
            style={styles.input}
          />

          <input
            placeholder="Password"
            type="password"
            style={styles.input}
          />

          <button style={styles.button}>
            Create Account
          </button>

          <p style={styles.text}>
            Already have an account?{" "}
            <Link to="/">
              Back to Login
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    fontFamily: "Arial",
  },

  header: {
    backgroundColor: "#1b9586",
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
    backgroundColor: "#1b9586",
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