const API_URL = import.meta.env.VITE_API_URL;

if (!API_URL) {
  throw new Error("VITE_API_URL is not configured");
}

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

export const api = {
  register: (email, password) =>
    request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  login: (email, password) =>
    request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  getDevices: () =>
    request("/api/devices", {
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem("token")}`,
      },
    }),

  getReadings: () =>
    request("/readings", {
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem("token")}`,
      },
    }),
    getDashboard: (deviceId) =>
  request(`/api/dashboard/${encodeURIComponent(deviceId)}?hours=6`, {
    headers: {
      Authorization: `Bearer ${sessionStorage.getItem("token")}`,
    },
  }),

    getAlerts: () =>
    request("/alerts", {
        headers: {
        Authorization: `Bearer ${sessionStorage.getItem("token")}`,
        },
    }),

    addDevice: (device) =>
    request("/api/devices", {
        method: "POST",
        headers: {
        Authorization: `Bearer ${sessionStorage.getItem("token")}`,
        },
        body: JSON.stringify(device),
    }),
};
