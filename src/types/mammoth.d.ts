declare module "mammoth" {
  interface Message {
    type: string;
    message: string;
  }

  interface Result {
    value: string;
    messages: Message[];
  }

  interface Options {
    buffer?: Buffer;
    path?: string;
  }

  function extractRawText(options: Options): Promise<Result>;
  function convertToHtml(options: Options): Promise<Result>;
  function convertToMarkdown(options: Options): Promise<Result>;
}
