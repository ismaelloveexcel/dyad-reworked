// Update this page (the content is just a fallback if you fail to update the page)

const CHECKOUT_URL = (import.meta as unknown as Record<string, Record<string, string>>).env
  ?.VITE_CHECKOUT_URL as string | undefined;

const Index = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold mb-4">Welcome to Your Blank App</h1>
        <p className="text-xl text-gray-600">
          Start building your amazing project here!
        </p>
        <div className="mt-8 rounded-xl border p-6 space-y-3 bg-white shadow-sm max-w-sm mx-auto">
          <p className="text-lg font-semibold">Unlock full access</p>
          <a
            href={CHECKOUT_URL ?? "#"}
            className="inline-block px-6 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
          >
            {CHECKOUT_URL ? "Buy Now" : "Checkout not configured"}
          </a>
        </div>
      </div>
    </div>
  );
};

export default Index;
