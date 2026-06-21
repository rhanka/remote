// WebSocket-based terminal client for the CP terminal endpoint.
// Connect to wss://<cp>/sessions/<id>/terminal
// Sends user input as binary frames, receives output as binary frames.
// Sends resize as JSON text frames: { type: "resize", cols, rows }
export { TerminalTransportClient } from "./client.js";
