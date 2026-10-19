"use client";

import { io, type Socket } from "socket.io-client";

// Where the live connection goes.
//
// Deployed, the web app proxies the API through its own origin so auth
// cookies stay first-party, and NEXT_PUBLIC_API_URL is left relative ("/" or
// empty). The socket must follow the same route: it used to be pointed at
// whatever NEXT_PUBLIC_API_URL held, "/" included, which sent it to the web
// app's /socket.io where nothing listens, so price alerts never arrived.
// A full URL (local development against :4000) is still used as given.
const configured = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const API_URL = /^https?:\/\//.test(configured) ? configured : undefined;

let socket: Socket | null = null;

// Single shared connection. Auth rides on the httpOnly cookie (withCredentials),
// so there's no token to pass. Safe to call repeatedly.
export function getSocket(): Socket {
  if (!socket) {
    const options = {
      path: "/socket.io",
      // "/socket.io/" would be redirected by the web app to "/socket.io"
      // before the proxy sees it. Without the slash it goes straight through.
      addTrailingSlash: false,
      withCredentials: true,
      autoConnect: true,
      // Long polling first: it works through the web app's proxy everywhere,
      // and upgrades to a WebSocket wherever the path allows one.
      transports: ["polling", "websocket"],
    };
    socket = API_URL ? io(API_URL, options) : io(options);
  }
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
