// DYAD GENERATED APP — placeholder strings are replaced by the factory scaffolder.
// __DYAD_APP_NAME__, __DYAD_TAGLINE__, __DYAD_BUYER__, __DYAD_PROBLEM__,
// __DYAD_MONETISATION__, __DYAD_VIRAL_TRIGGER__ are substituted at scaffold time.

import { useState } from "react";
import { CheckoutButton } from "@/components/CheckoutButton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const APP_NAME = "__DYAD_APP_NAME__";
const TAGLINE = "__DYAD_TAGLINE__";
const BUYER = "__DYAD_BUYER__";
const PROBLEM = "__DYAD_PROBLEM__";
const MONETISATION = "__DYAD_MONETISATION__";
const VIRAL_TRIGGER = "__DYAD_VIRAL_TRIGGER__";

const Index = () => {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [copied, setCopied] = useState(false);

  const handleAnalyze = () => {
    setOutput(`Result for: ${input}`);
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = () => {
    if (navigator.share) {
      void navigator.share({ title: APP_NAME, text: output });
    } else {
      void handleCopy();
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Hero Section */}
      <section className="bg-primary text-primary-foreground py-20 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-4xl md:text-6xl font-bold mb-4">{APP_NAME}</h1>
          <p className="text-xl md:text-2xl opacity-90 mb-8">{TAGLINE}</p>
          <a
            href="#tool"
            className="inline-block bg-background text-primary font-semibold px-8 py-3 rounded-lg hover:opacity-90 transition"
          >
            Try it free
          </a>
        </div>
      </section>

      {/* Problem / Buyer Section */}
      <section className="py-16 px-4 bg-muted">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold mb-4">Built for {BUYER}</h2>
          <p className="text-lg text-muted-foreground">{PROBLEM}</p>
          <p className="mt-4 text-sm font-medium text-primary">
            {VIRAL_TRIGGER}
          </p>
        </div>
      </section>

      {/* Interactive Tool Section */}
      <section id="tool" className="py-16 px-4">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold mb-6 text-center">Try it now</h2>
          <Textarea
            placeholder="Enter your details here…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="mb-4 min-h-[120px]"
          />
          <Button
            onClick={handleAnalyze}
            disabled={!input.trim()}
            className="w-full mb-6"
          >
            Generate result
          </Button>
          {output && (
            <div className="p-4 rounded-lg border bg-card">
              <p className="text-card-foreground mb-4 whitespace-pre-wrap">
                {output}
              </p>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopy()}
                >
                  {copied ? "Copied!" : "Copy"}
                </Button>
                <Button variant="outline" size="sm" onClick={handleShare}>
                  Share
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Pricing / Paywall Section */}
      <section className="py-16 px-4 bg-muted">
        <div className="max-w-xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-4">Unlock full access</h2>
          <p className="text-muted-foreground mb-8">{MONETISATION}</p>
          <div className="bg-card rounded-xl border p-8 shadow-sm">
            <div className="text-4xl font-bold mb-2">$29</div>
            <div className="text-muted-foreground mb-6">one-time payment</div>
            <ul className="text-sm text-left space-y-2 mb-8">
              <li>✓ Unlimited uses</li>
              <li>✓ Export &amp; share results</li>
              <li>✓ Priority support</li>
            </ul>
            <CheckoutButton />
          </div>
        </div>
      </section>

      <footer className="py-8 px-4 text-center text-sm text-muted-foreground">
        &copy; {new Date().getFullYear()} {APP_NAME}. All rights reserved.
      </footer>
    </div>
  );
};

export default Index;
