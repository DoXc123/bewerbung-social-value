// Sending the code. A real provider would be an HTTPS call, so the interface is
// async and may fail; the server handles both. The only sender here is a mock
// that writes the message to the log instead: no SMS ever leaves this service.

export type SmsSender = {
  send(to: string, text: string): Promise<void>;
};

export function createLogSender(log: (line: string) => void): SmsSender {
  return {
    async send(to, text) {
      log(`[sms mock] to ${to}: ${text}`);
    },
  };
}

export function codeMessage(code: string, validMinutes: number): string {
  return `Your voting code is ${code}. It is valid for ${validMinutes} minutes.`;
}
