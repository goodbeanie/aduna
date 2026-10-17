import { io } from 'socket.io-client';

let token = localStorage.getItem('aduna_token') || '';

export const getToken = () => token;
export function setToken(t) {
  token = t || '';
  if (t) localStorage.setItem('aduna_token', t);
  else localStorage.removeItem('aduna_token');
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

export const connectSocket = () => io({ auth: { token } });

export const emitAck = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (err, res) => {
      if (err) return reject(new Error('Timed out'));
      if (res?.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
