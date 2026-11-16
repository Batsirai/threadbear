import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { ConvexError } from 'convex/values';
import { App } from './App';
import { api } from '../../convex/_generated/api';
import { claimSignIn, takeSignInCodeFromHash } from './token';
import { applyTheme } from './theme';
import './styles.css';

// A sign-in link (the Mac's Open signed in, or `npm run web:sign-in`)
// carries a one-use code in the fragment, which never reaches a server. Take
// it and wipe it from the address bar before anything renders, then trade it
// for this browser's token (token.ts says why it's never the token itself).
const signInCode = takeSignInCodeFromHash();
applyTheme();

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
if (signInCode) void claimSignIn((code) => convex.mutation(api.tokens.claim, { code }), signInCode, (e) => e instanceof ConvexError);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
