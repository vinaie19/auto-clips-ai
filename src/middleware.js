import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Clerk session middleware. Route-level auth checks live in API handlers
 * so unauthenticated API calls receive JSON 401 instead of HTML redirects.
 * The marketing page (`/`) remains publicly accessible.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
