export interface NamedPeer { id: string; name: string }

export function resolveAppUrl(baseUri: string, path: string): string {
  return new URL(path.replace(/^\//, ""), baseUri).toString();
}

export function findExactReceiver<T extends NamedPeer>(peers: T[], receiverName: string): T | undefined {
  return peers.find((peer) => peer.name === receiverName);
}

export function findUniqueReceiver<T extends NamedPeer>(peers: T[], receiverName: string): T | undefined {
  const matches = peers.filter((peer) => peer.name === receiverName);
  return matches.length === 1 ? matches[0] : undefined;
}
