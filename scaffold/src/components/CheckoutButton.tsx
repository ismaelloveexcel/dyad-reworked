import { Button } from "@/components/ui/button";

const CHECKOUT_URL = import.meta.env.VITE_CHECKOUT_URL as string | undefined;

/**
 * CheckoutButton reads VITE_CHECKOUT_URL from the Vite environment at build
 * time and renders a disabled state with a clear message when the variable is
 * not configured. Any hosted payment or checkout link works — Lemon Squeezy,
 * Stripe Payment Links, Gumroad, Ko-fi, or a manual payment page.
 */
export function CheckoutButton() {
  if (!CHECKOUT_URL) {
    return (
      <Button
        disabled
        className="w-full opacity-60 cursor-not-allowed"
        title="Set VITE_CHECKOUT_URL in .env to enable checkout"
      >
        Checkout not configured
      </Button>
    );
  }

  return (
    <Button asChild className="w-full">
      <a href={CHECKOUT_URL} target="_blank" rel="noopener noreferrer">
        Buy Now
      </a>
    </Button>
  );
}
