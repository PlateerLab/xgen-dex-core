import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
  wide: boolean;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => {
    const columns = stdout.columns || 100;
    const rows = stdout.rows || 30;
    return { columns, rows, wide: columns >= 88 };
  };
  const [size, setSize] = useState(read);
  useEffect(() => {
    const resize = (): void => setSize(read());
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout]);
  return size;
}
