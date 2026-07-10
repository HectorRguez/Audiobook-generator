declare module "html-to-text" {
  export function convert(html: string, options?: Record<string, unknown>): string;
}

declare module "moving-averages" {
  export function ema(values: number[], period: number): number[];
}
