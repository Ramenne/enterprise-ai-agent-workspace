// A QR is data, never a URL to navigate or an authority for account identity.
export function parsePairingQr(value: string): string {
  const match = /^employeeclient-pair:v1:([A-F0-9]{16})$/.exec(value);
  if (!match) throw new Error('这不是员工客户端连接器的配对二维码，请扫描 Mac 上的二维码。');
  return match[1];
}
