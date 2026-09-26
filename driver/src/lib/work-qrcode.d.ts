/** qrcode ^1.5.4 بلا أنواع مرفقة: ما نستعمله منها وحده (رمز QR لنقطة الاستلام، م-3). */
declare module "qrcode" {
  interface QRCodeOptions {
    type?: "svg" | "utf8" | "terminal";
    margin?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }
  const QRCode: {
    toString(text: string, opts?: QRCodeOptions): Promise<string>;
  };
  export default QRCode;
}
