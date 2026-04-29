import Link from "next/link";
import { Timeline } from "@/components/tracking";
import { QrCode, ArrowLeft, PlusCircle } from "lucide-react";

export default async function ProductDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      {/* Back navigation */}
      <Link
        href="/products"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 mb-6 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to Products
      </Link>

      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Product Tracking</h1>
          <p className="mt-2 text-sm text-gray-600">
            Product ID:{" "}
            <span className="font-mono font-medium bg-gray-100 px-2 py-0.5 rounded">
              {id}
            </span>
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3 shrink-0">
          <Link
            href={`/verify/${id}`}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            <QrCode className="h-4 w-4" aria-hidden="true" />
            View QR Code
          </Link>
          <Link
            href={`/tracking/add?productId=${encodeURIComponent(id)}`}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 transition-colors"
          >
            <PlusCircle className="h-4 w-4" aria-hidden="true" />
            Add Event
          </Link>
        </div>
      </div>

      {/* Timeline */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-6 text-xl font-semibold text-gray-900">
          Supply Chain Timeline
        </h2>
        <Timeline productId={id} />
      </div>
    </main>
  );
}
