export {};
try {
  const response = await fetch("http://127.0.0.1:3847/api/files", {
    headers: { authorization: `Bearer ${process.env.AUTH_KEY || ""}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) process.exit(1);
  await response.body?.cancel();
} catch { process.exit(1); }
