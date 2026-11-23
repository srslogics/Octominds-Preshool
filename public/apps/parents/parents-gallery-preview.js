// Synthetic SVG illustrations, never photographs of real children.
const art = (name, color, shape) =>
  new Blob(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="675" viewBox="0 0 900 675"><rect width="900" height="675" fill="${color}"/><circle cx="735" cy="105" r="56" fill="#fff" opacity=".45"/>${shape}<text x="55" y="575" font-family="sans-serif" font-size="35" fill="#244b43">${name}</text><text x="55" y="620" font-family="sans-serif" font-size="20" fill="#395f56">Sample illustration · OctoMinds preview</text></svg>`,
    ],
    { type: "image/svg+xml" },
  );
export function previewGallery({
  id,
  day,
  classA,
  classB,
  staff,
  role,
  students,
}) {
  const images = new Map(),
    albums = [
      {
        id: id(80),
        class_id: classA,
        student_id: null,
        title: "Our colour explorers",
        description: "A morning of colour, curiosity, and little discoveries.",
        taken_on: day(-1),
        status: "published",
        photos: [
          { id: id(81), caption: "Mixing a little magic", status: "ready" },
          {
            id: id(82),
            caption: "A rainbow of possibilities",
            status: "ready",
          },
          { id: id(83), caption: "Discoveries in the garden", status: "ready" },
        ],
      },
      {
        id: id(84),
        class_id: classB,
        student_id: null,
        title: "A story in every leaf",
        description: "Finding patterns and shapes in the world around us.",
        taken_on: day(-3),
        status: "published",
        photos: [{ id: id(85), caption: "Our nature table", status: "ready" }],
      },
    ];
  images.set(
    id(81),
    art(
      "Colour explorers",
      "#f7dfc2",
      '<rect x="140" y="160" width="155" height="240" rx="35" fill="#d78875" transform="rotate(-12 220 280)"/><rect x="365" y="130" width="155" height="265" rx="35" fill="#f1bf54" transform="rotate(8 440 260)"/><rect x="590" y="170" width="155" height="240" rx="35" fill="#75a99b" transform="rotate(18 660 290)"/>',
    ),
  );
  images.set(
    id(82),
    art(
      "A world of colour",
      "#dcefe9",
      '<path d="M150 450a300 300 0 0 1 600 0" fill="none" stroke="#c57a8f" stroke-width="65"/><path d="M220 450a230 230 0 0 1 460 0" fill="none" stroke="#e6b85b" stroke-width="65"/><path d="M290 450a160 160 0 0 1 320 0" fill="none" stroke="#7fa493" stroke-width="65"/>',
    ),
  );
  const leaves = art(
    "Little nature discoveries",
    "#e4ecd1",
    '<path d="M455 470V170" stroke="#57765b" stroke-width="15"/><ellipse cx="365" cy="260" rx="110" ry="48" fill="#8cae73" transform="rotate(30 365 260)"/><ellipse cx="550" cy="340" rx="120" ry="50" fill="#799567" transform="rotate(-25 550 340)"/><ellipse cx="450" cy="170" rx="48" ry="90" fill="#b0c389"/>',
  );
  images.set(id(83), leaves);
  images.set(id(85), leaves);
  function find(albumId) {
    const a = albums.find((a) => a.id === albumId);
    if (!a) throw Error("Album unavailable.");
    return a;
  }
  function detail(a) {
    return { ...structuredClone(a), can_manage: role() === "staff" };
  }
  return async function request(path, body, method, headers = {}) {
    const url = new URL(path, "https://preview.invalid"),
      parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "gallery" && parts[1] === "staff") {
      const list =
        role() === "staff"
          ? albums.filter((a) => a.status !== "withdrawn")
          : [];
      return {
        albums: list.map((a) => ({
          ...detail(a),
          class_name: a.class_id === classA ? "Nursery A" : "Kindergarten B",
          student_name: students.find((s) => s.id === a.student_id)?.full_name,
        })),
        total: list.length,
        page: 1,
        page_size: 12,
      };
    }
    if (path === "/gallery/cleanup") return { albums: [] };
    if (parts[0] === "children" && parts[2] === "gallery") {
      const s = students.find((s) => s.id === parts[1]);
      const list = albums
        .filter(
          (a) =>
            a.class_id === s.class_id &&
            (!a.student_id || a.student_id === s.id) &&
            a.status !== "withdrawn" &&
            (a.status === "published" || role() === "staff"),
        )
        .sort((a, b) => b.taken_on.localeCompare(a.taken_on));
      return {
        albums: list.map(detail),
        total: list.length,
        page: 1,
        page_size: 12,
      };
    }
    if (parts[0] === "photos" && parts[2] === "image") {
      const blob = images.get(parts[1]);
      if (!blob) throw Error("Photo unavailable.");
      return blob;
    }
    if (path === "/albums") {
      if (role() !== "staff") throw Error("School team access required.");
      const a = {
        ...body,
        id: crypto.randomUUID(),
        status: "draft",
        photos: [],
      };
      albums.unshift(a);
      return detail(a);
    }
    if (parts[0] === "albums") {
      const a = find(parts[1]);
      if (parts.length === 2 && method === "GET") return detail(a);
      if (role() !== "staff") throw Error("School team access required.");
      if (parts[2] === "photos" && method === "POST") {
        let p = a.photos.find((p) => p.id === parts[3]);
        if (!p) {
          p = {
            id: parts[3],
            caption: decodeURIComponent(headers["X-Photo-Caption"] || ""),
            status: "ready",
          };
          a.photos.push(p);
        }
        images.set(p.id, body);
        return structuredClone(p);
      }
      if (parts[2] === "photos" && method === "DELETE") {
        a.photos = a.photos.filter((p) => p.id !== parts[3]);
        images.delete(parts[3]);
        if (a.status === "published" && !a.photos.length)
          a.status = "withdrawn";
        return { id: a.id, cleanup_pending: false };
      }
      if (parts[2] === "publish") {
        if (!a.photos.length) throw Error("Choose at least one photo.");
        a.status = "published";
        return { id: a.id };
      }
      if (method === "DELETE") {
        a.status = "withdrawn";
        a.photos.forEach((p) => images.delete(p.id));
        return { id: a.id, cleanup_pending: false };
      }
    }
    throw Error("Unknown preview gallery action.");
  };
}
