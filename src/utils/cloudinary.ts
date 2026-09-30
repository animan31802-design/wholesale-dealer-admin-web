// Same Cloudinary account/preset as product images (see pages/Products.tsx).
const CLOUDINARY_CLOUD_NAME = "drqh2oeb1";
const CLOUDINARY_UPLOAD_PRESET = "wholesale_products";

export async function uploadToCloudinary(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: formData });
  if (!res.ok) throw new Error("Image upload failed. Please try again.");
  const data = await res.json();
  return data.secure_url as string;
}
