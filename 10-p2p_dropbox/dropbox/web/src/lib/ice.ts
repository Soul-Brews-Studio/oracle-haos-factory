export interface IceCandidateTarget {
  remoteDescription: unknown;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<unknown>;
}

export class PendingIceCandidates {
  private candidates = new Map<string, RTCIceCandidateInit[]>();

  async addOrQueue(peerId: string, pc: IceCandidateTarget, candidate: RTCIceCandidateInit): Promise<void> {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(candidate);
      return;
    }
    const pending = this.candidates.get(peerId) || [];
    pending.push(candidate);
    this.candidates.set(peerId, pending);
  }

  async drain(peerId: string, pc: IceCandidateTarget): Promise<void> {
    const pending = this.candidates.get(peerId) || [];
    this.candidates.delete(peerId);
    for (const candidate of pending) await pc.addIceCandidate(candidate);
  }

  clear(peerId: string): void {
    this.candidates.delete(peerId);
  }
}
