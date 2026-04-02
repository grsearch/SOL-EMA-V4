// src/wsHub.js — broadcast to all connected dashboard clients
const WebSocket = require('ws');

function broadcastToClients(payload) {
  const wss = global._wss;
  if (!wss) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

module.exports = { broadcastToClients };
