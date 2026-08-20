declare const Netlify: {
  env: { get(name: string): string | undefined };
  context?: any;
};
