import { useEffect, useRef, useState } from "react";

interface MapPickerProps {
  initialLat?: number;
  initialLng?: number;
  onConfirm: (lat: number, lng: number, address: string) => void;
  onClose: () => void;
}

declare const L: any;

export default function MapPicker({ initialLat, initialLng, onConfirm, onClose }: MapPickerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const [lat, setLat] = useState(initialLat || 13.0827);
  const [lng, setLng] = useState(initialLng || 80.2707); // Default: Chennai
  const [address, setAddress] = useState("");
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [gettingLocation, setGettingLocation] = useState(false);

  const reverseGeocode = async (lat: number, lng: number) => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`
      );
      const data = await res.json();
      return data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    } catch {
      return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
  };

  const updateMarker = async (lat: number, lng: number) => {
    setLat(lat);
    setLng(lng);
    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng]);
    }
    const addr = await reverseGeocode(lat, lng);
    setAddress(addr);
  };

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    const map = L.map(mapRef.current).setView([lat, lng], 14);
    mapInstanceRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);

    const marker = L.marker([lat, lng], { draggable: true }).addTo(map);
    markerRef.current = marker;

    marker.on("dragend", async () => {
      const pos = marker.getLatLng();
      await updateMarker(pos.lat, pos.lng);
    });

    map.on("click", async (e: any) => {
      await updateMarker(e.latlng.lat, e.latlng.lng);
      marker.setLatLng([e.latlng.lat, e.latlng.lng]);
    });

    // Initial reverse geocode
    reverseGeocode(lat, lng).then(setAddress);

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  const handleSearch = async () => {
    if (!search.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(search)}&format=json&limit=1`
      );
      const data = await res.json();
      if (data.length > 0) {
        const { lat: newLat, lon: newLng } = data[0];
        const parsedLat = parseFloat(newLat);
        const parsedLng = parseFloat(newLng);
        mapInstanceRef.current?.setView([parsedLat, parsedLng], 16);
        await updateMarker(parsedLat, parsedLng);
      } else {
        alert("Location not found. Try a more specific search.");
      }
    } catch {
      alert("Search failed. Please try again.");
    } finally {
      setSearching(false);
    }
  };

  const handleCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert("Geolocation not supported by your browser.");
      return;
    }
    setGettingLocation(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        mapInstanceRef.current?.setView([latitude, longitude], 17);
        await updateMarker(latitude, longitude);
        markerRef.current?.setLatLng([latitude, longitude]);
        setGettingLocation(false);
      },
      () => {
        alert("Could not get your location. Please allow location access.");
        setGettingLocation(false);
      }
    );
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-800">📍 Pick Shop Location</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        {/* Search Bar */}
        <div className="px-5 py-3 border-b border-gray-100 flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search area, street, city..."
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
          />
          <button
            onClick={handleSearch}
            disabled={searching}
            className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-orange-600 disabled:opacity-50"
          >
            {searching ? "..." : "Search"}
          </button>
          <button
            onClick={handleCurrentLocation}
            disabled={gettingLocation}
            className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
            title="Use current location"
          >
            {gettingLocation ? "..." : "📌 My Location"}
          </button>
        </div>

        {/* Map */}
        <div ref={mapRef} className="w-full" style={{ height: "360px" }} />

        {/* Selected Location Info */}
        <div className="px-5 py-3 bg-gray-50 border-t border-gray-100">
          <p className="text-xs text-gray-500 mb-1">Selected Location</p>
          <p className="text-sm text-gray-700 font-medium truncate">{address || "Click or drag pin on map"}</p>
          <p className="text-xs text-gray-400 mt-1">
            Lat: {lat.toFixed(6)} | Lng: {lng.toFixed(6)}
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 px-5 py-4 border-t border-gray-100">
          <button onClick={onClose}
            className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-xl text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(lat, lng, address)}
            className="flex-1 bg-orange-500 text-white py-2 rounded-xl text-sm font-semibold hover:bg-orange-600"
          >
            ✅ Confirm Location
          </button>
        </div>
      </div>
    </div>
  );
}
