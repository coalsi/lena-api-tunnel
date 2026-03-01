import ngrok from "@ngrok/ngrok";

export interface TunnelInfo {
  url: string;
}

let currentListener: Awaited<ReturnType<typeof ngrok.forward>> | null = null;

export async function startTunnel(port: number, authtoken?: string): Promise<TunnelInfo> {
  currentListener = await ngrok.forward({
    addr: port,
    ...(authtoken ? { authtoken } : { authtoken_from_env: true }),
  });
  const url = currentListener.url();
  if (!url) throw new Error("Failed to get tunnel URL");
  return { url };
}

export async function restartTunnel(port: number, authtoken?: string): Promise<TunnelInfo> {
  await stopTunnel();
  return startTunnel(port, authtoken);
}

export async function stopTunnel(): Promise<void> {
  if (currentListener) {
    await currentListener.close();
    currentListener = null;
  }
}
