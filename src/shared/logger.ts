export const debug = (...args: any[]) => {
  if (process.env.DEBUG_LOG === '1') {
    // keep as debug to avoid noise in normal runs
    // eslint-disable-next-line no-console
    console.debug(...args);
  }
};

export const info = (...args: any[]) => {
  // eslint-disable-next-line no-console
  console.log(...args);
};

export const warn = (...args: any[]) => {
  // eslint-disable-next-line no-console
  console.warn(...args);
};

export const error = (...args: any[]) => {
  // eslint-disable-next-line no-console
  console.error(...args);
};

export default { debug, info, warn, error };



