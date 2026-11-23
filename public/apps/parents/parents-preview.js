import { previewGallery } from "./parents-gallery-preview.js?v=1";
// Deliberately synthetic, memory-only examples. Never used after a live API failure.
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const timeToday = (hour, minute) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};
export function createPreview() {
  let role = "parent";
  const branch = id(1),
    classA = id(2),
    classB = id(3),
    parent = id(4),
    staff = id(5);
  const students = [
    {
      id: id(10),
      branch_id: branch,
      class_id: classA,
      full_name: "Aarohi Sharma",
      center_name: "Green Park",
      class_name: "Nursery A",
      year_name: "2026–27",
      relationship: "Mother",
      is_active: true,
      version: 1,
      today: {
        group: "Tiny Explorers",
        arrival: "Arrived at 8:45 AM · Happy and playful 😊",
        current: {
          title: "Currently: Nap & Quiet Rest",
          note: "Asleep peacefully since 1:15 PM with a blue blanket.",
          remaining: "45 min left",
        },
        pickup: "1:30 PM · Sample pass",
        updated: "Updated 1:20 PM",
        routines: [
          ["🥪", "Lunch (12:15)", "Ate it all", "Paneer khichdi and sweet papaya", "mint"],
          ["😴", "Rest time", "Sleeping", "1:15 PM · Settled in their cot", "plum"],
          ["💧", "Water & potty", "2 bottles", "2 potty breaks · Drank water regularly", "blue"],
        ],
        menu: {
          snack: "Snack: Watermelon cubes",
          evening: "Evening: Warm milk and an oat cookie",
          lunch: "Lunch: Paneer khichdi with sweet papaya.",
        },
      },
      profile: {
        avatar: "👧🏽",
        nickname: "Aaru",
        class_label: "Tiny Explorers (Nursery A)",
        cubby: "Cubby #12",
        check_in: "Checked in · 8:45 AM",
        age: "3 years, 4 months",
        pickup_code: "#8492",
        team: [
          { full_name: "Meera Kapoor", role: "Lead Teacher", avatar: "👩🏽‍🏫",
            description: "Early learning, classroom activities and family updates." },
          { full_name: "Sunita Didi", role: "Class Caregiver", avatar: "👩🏽",
            description: "Meals, rest time and daily care routines." },
        ],
        care: [
          ["Allergies", "✓", "No known allergies"],
          ["Diet plan", "🥦", "Lacto-vegetarian"],
          ["Blood group", "🩸", "B positive (B+)"],
          ["Nap routine", "😴", "1:00 PM · 45 minutes"],
        ],
        pickups: [
          { full_name: "Ananya Sharma", relationship: "Mother · Primary account" },
          { full_name: "Arjun Sharma", relationship: "Father" },
        ],
        milestones: [
          ["🎨", "Little Picasso"], ["🧩", "Puzzle Pro"],
          ["🤝", "Kind Sharer"], ["👟", "Shoes Star"],
        ],
      },
    },
    {
      id: id(11),
      branch_id: branch,
      class_id: classB,
      full_name: "Vihaan Sharma",
      center_name: "Green Park",
      class_name: "Kindergarten B",
      year_name: "2026–27",
      relationship: "Mother",
      is_active: true,
      version: 1,
      profile: {
        avatar: "🧒🏽",
        nickname: "Vian",
        class_label: "Story Builders (Kindergarten B)",
        cubby: "Cubby #07",
        check_in: "Checked in · 8:55 AM",
        age: "5 years, 2 months",
        team: [
          { full_name: "Meera Kapoor", role: "Class teacher", avatar: "👩🏽‍🏫" },
        ],
        milestones: [["📚", "Story Starter"], ["🌱", "Garden Helper"]],
      },
    },
  ];
  const classes = [
    {
      id: classA,
      branch_id: branch,
      name: "Nursery A",
      center_name: "Green Park",
      year_name: "2026–27",
      can_manage: true,
    },
    {
      id: classB,
      branch_id: branch,
      name: "Kindergarten B",
      center_name: "Green Park",
      year_name: "2026–27",
      can_manage: true,
    },
  ];
  const posts = [
    {
      id: id(20),
      class_id: classA,
      kind: "diary",
      title: "Finger Painting: Spring Blossoms",
      body: "Aarohi was so focused and shared the paint pots kindly!",
      author_name: "Meera · Class teacher",
      created_at: timeToday(10, 45),
      created_by: staff,
      today_feature: { symbol: "🎨", category: "Sensory art", quote: "Look, teacher! I mixed yellow and blue to make green leaves!" },
    },
    {
      id: id(21),
      class_id: classA,
      kind: "homework",
      title: "A little counting adventure",
      body: "Find five of your favourite toys and count them together. Can you sort them by colour, too?\n\nA few happy minutes of play are all you need. There’s nothing to submit.",
      author_name: "Meera · Class teacher",
      created_at: new Date(Date.now() - 3600000).toISOString(),
      created_by: staff,
    },
    {
      id: id(22),
      class_id: classA,
      kind: "notice",
      title: "A morning for our school community",
      body: "You’re invited to our family morning! Join us for stories, music, and a peek into your little one’s world of learning.\n\nPlease send a water bottle and wear comfortable shoes. We look forward to seeing you.",
      author_name: "The Green Park team",
      created_at: new Date(Date.now() - 86400000).toISOString(),
      created_by: staff,
    },
    {
      id: id(23),
      class_id: classA,
      kind: "event",
      title: "Yellow Sunshine Day & Fruit Party 🍌",
      body: "Wear yellow and bring a favourite fruit to share.",
      event_date: day(3),
      author_name: "The Green Park team",
      created_at: new Date().toISOString(),
      created_by: staff,
    },
    {
      id: id(26),
      class_id: classA,
      kind: "diary",
      title: "Garden Obstacle Course & Sandbox",
      body: "Ran across the balancing bridge twice and built a sand pyramid with friends.",
      author_name: "Meera · Class teacher",
      created_at: timeToday(9, 30),
      created_by: staff,
      today_feature: { symbol: "🏃", category: "Outdoors" },
    },
    {
      id: id(24),
      class_id: classB,
      kind: "homework",
      title: "Bring a story to share",
      body: "Choose a favourite book and tell us about one character you love. We’ll share our stories in class tomorrow.",
      author_name: "Riya · Class teacher",
      created_at: new Date().toISOString(),
      created_by: staff,
    },
    {
      id: id(25),
      class_id: classB,
      kind: "event",
      title: "Show and tell",
      body: "Bring something small that tells a big story.",
      event_date: day(2),
      author_name: "Riya · Class teacher",
      created_at: new Date().toISOString(),
      created_by: staff,
    },
  ];
  const messages = [
    {
      id: id(30),
      student_id: id(10),
      body: "Hello! Aarohi has been telling us all about the colour activity. Is there anything we can try together at home?",
      author_name: "You",
      is_own: true,
      created_at: new Date(Date.now() - 7200000).toISOString(),
      role: "parent",
    },
    {
      id: id(31),
      student_id: id(10),
      body: "Lovely to hear! A walk to collect fallen leaves is a wonderful start. Let her choose the colours and see what she discovers.",
      author_name: "Meera · Class teacher",
      is_own: false,
      created_at: new Date(Date.now() - 3600000).toISOString(),
      role: "staff",
    },
  ];
  const guardians = [
    {
      id: id(40),
      student_id: id(10),
      user_id: parent,
      relationship: "Mother",
      is_active: true,
    },
    {
      id: id(41),
      student_id: id(11),
      user_id: parent,
      relationship: "Mother",
      is_active: true,
    },
  ];
  const accounts = [
    {
      user_id: parent,
      branch_id: branch,
      full_name: "Ananya Sharma",
      email: "ananya@example.invalid",
    },
  ];
  const gallery = previewGallery({
    id,
    day,
    classA,
    classB,
    staff,
    role: () => role,
    students,
  });
  return {
    setRole(value) {
      role = value;
    },
    user() {
      return {
        id: role === "staff" ? staff : parent,
        full_name: role === "staff" ? "Meera Kapoor" : "Ananya Sharma",
        role: role === "staff" ? "branch_admin" : "parent",
      };
    },
    async request(path, body, method = "GET", headers = {}) {
      if (
        path.includes("/gallery") ||
        path.startsWith("/albums") ||
        path.startsWith("/photos")
      )
        return gallery(path, body, method, headers);
      const url = new URL(path, "https://preview.invalid");
      const parts = url.pathname.split("/").filter(Boolean),
        page = Number(url.searchParams.get("page") || 1);
      const listFor = (student) =>
        posts.filter(
          (p) =>
            p.class_id === student.class_id &&
            (!p.student_id || p.student_id === student.id) &&
            !p.withdrawn,
        );
      if (path === "/workspace")
        return structuredClone({
          students: students
            .filter(
              (s) =>
                role === "staff" ||
                (s.is_active &&
                  guardians.some(
                    (g) =>
                      g.student_id === s.id &&
                      g.user_id === parent &&
                      g.is_active,
                  )),
            )
            .map((s) => ({
              ...s,
              can_manage: role === "staff",
              can_publish: role === "staff",
            })),
          classes: role === "staff" ? classes : [],
          guardians: role === "staff" ? guardians : [],
          parent_accounts: role === "staff" ? accounts : [],
        });
      if (parts[0] === "children") {
        const student = students.find((s) => s.id === parts[1]);
        if (!student) throw Error("Child is unavailable.");
        if (parts[2] === "posts") {
          const kind = url.searchParams.get("kind") || "all";
          const filtered = listFor(student)
            .filter((p) => kind === "all" || p.kind === kind)
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
          return {
            posts: structuredClone(
              filtered.slice((page - 1) * 20, page * 20),
            ).map((p) => ({ ...p, can_withdraw: role === "staff" })),
            total: filtered.length,
            page,
            page_size: 20,
          };
        }
        if (parts[2] === "calendar") {
          const month = url.searchParams.get("month").slice(0, 7);
          return {
            events: structuredClone(
              listFor(student).filter(
                (p) => p.kind === "event" && p.event_date.startsWith(month),
              ),
            ),
            holidays: [],
          };
        }
        if (parts[2] === "messages") {
          if (body) {
            messages.push({
              id: crypto.randomUUID(),
              student_id: student.id,
              body: body.body,
              author_name: role === "staff" ? "Meera Kapoor" : "Ananya Sharma",
              role,
              created_at: new Date().toISOString(),
            });
            return { id: messages.at(-1).id };
          }
          const filtered = messages.filter((m) => m.student_id === student.id);
          return {
            messages: structuredClone(
              filtered.slice(
                Math.max(0, filtered.length - page * 30),
                filtered.length - (page - 1) * 30,
              ),
            ).map((m) => ({ ...m, is_own: m.role === role })),
            total: filtered.length,
            page,
            page_size: 30,
          };
        }
      }
      if (role !== "staff") throw Error("School team access required.");
      if (path === "/students") {
        if (body.id) {
          const s = students.find((s) => s.id === body.id);
          if (s.version !== body.version)
            throw Error("This record changed. Reload before saving.");
          Object.assign(s, body, { version: s.version + 1 });
          return structuredClone(s);
        }
        const c = classes.find((c) => c.id === body.class_id);
        const s = {
          ...body,
          id: crypto.randomUUID(),
          class_name: c.name,
          center_name: c.center_name,
          year_name: c.year_name,
          version: 1,
        };
        students.push(s);
        return s;
      }
      if (path === "/guardians") {
        let g = guardians.find(
          (g) => g.user_id === body.user_id && g.student_id === body.student_id,
        );
        if (g) Object.assign(g, body);
        else guardians.push({ ...body, id: crypto.randomUUID() });
        return { id: guardians.at(-1).id };
      }
      if (path === "/posts") {
        const post = {
          ...body,
          id: crypto.randomUUID(),
          created_by: staff,
          author_name: "Meera Kapoor",
          created_at: new Date().toISOString(),
        };
        posts.unshift(post);
        return post;
      }
      if (parts[0] === "posts" && method === "DELETE") {
        const p = posts.find((p) => p.id === parts[1]);
        if (p) p.withdrawn = true;
        return { id: parts[1] };
      }
      throw Error("This action is unavailable in preview.");
    },
  };
}
