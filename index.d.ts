import { Request, Response } from 'express';

export interface LeakInfo {
  url: string;
  method: string;
  timeout: number;
  activeTrace: {
    name: string;
    file: string;
    line: number;
    column: number;
    startTime: number;
    duration: number;
  } | null;
  breadcrumbs: Array<{
    name: string;
    file: string;
    line: number;
    column: number;
    duration: number;
    status: 'pending' | 'completed' | 'next_called' | 'response_sent' | 'hung';
  }>;
}

export interface LeakDetectorOptions {
  /**
   * Timeout threshold in milliseconds before a request is considered a zombie.
   * @default 5000
   */
  timeout?: number;

  /**
   * Custom logger object (must implement `error`).
   * @default console
   */
  logger?: {
    error(...args: any[]): void;
    [key: string]: any;
  };

  /**
   * URL paths to exclude from tracking. Can be exact matches, prefixes, or RegExp patterns.
   * @default []
   */
  excludePaths?: Array<string | RegExp>;

  /**
   * Custom callback function called when a leak is detected.
   * If specified, it overrides the default console logging.
   */
  onLeak?: (leakInfo: LeakInfo, req: Request, res: Response) => void;
}

/**
 * Initializes the Express request leak detector globally.
 * Must be called before registering any routers or middleware.
 */
export function initLeakDetector(options?: LeakDetectorOptions): void;
