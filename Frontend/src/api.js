const API_URL = import.meta.env.VITE_API_URL;

async function request(path, options = {}) {
  if (!API_URL) {
    throw new Error("VITE_API_URL is not configured");
  }

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

  forgotPassword: (email) =>
    request("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token, password) =>
    request("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
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

  commandDevice: (deviceId, status) =>
    request(`/api/devices/${encodeURIComponent(deviceId)}/command`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem("token")}`,
      },
      body: JSON.stringify({ status }),
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

  deleteDevice: (deviceId) =>
    request(`/api/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `******"token")}`,
      },
    }),
};
