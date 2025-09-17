/* Compile with `tsc app.ts --target ES2017 --module system --outFile app.js`
   or use any bundler. */

type Branch = { label: string; steps: Step[] };
type ActionStep = { action: { id: string; provider?: string; label: string; tool_name?: string; payload?: any } };
type SplitStep = { split: { id: string; label: string; branches: Branch[] } };
type SequentialStep = {
  sequential: Array<{
    label?: string;
    call_type?: string;
    tool_name: string;
    payload?: any;
    store_variables?: Array<{ variable_name: string; description: string }>;
  }>;
};
type Step = ActionStep | SplitStep | SequentialStep;

type Plan = { steps: Step[] };

const example: Plan = {
  steps: [
    {
      split: {
        id: "is_manager",
        label: "Is manager?",
        branches: [
          {
            label: "true",
            steps: [
              { action: { id: "add_to_channel", provider: "slack", label: "Add to channel", tool_name: "SLACK_INVITE_TO_CHANNEL", payload: { channel: "managers" } } }
            ]
          },
          {
            label: "false",
            steps: [
              { action: { id: "update_profile", provider: "slack", label: "Update profile", tool_name: "SLACK_UPDATE_PROFILE", payload: { title: "IC" } } }
            ]
          }
        ]
      }
    },
    {
      sequential: [
        { label: "Create product", call_type: "Composio", tool_name: "SHOPIFY_CREATE_PRODUCT", payload: { title: "iPhone" } },
        { label: "Generate image", call_type: "SELF_MADE", tool_name: "OPENAI_IMAGE_GENERATION", payload: { prompt_text: "iPhone", output_filename: "iphone.png" } },
        { label: "Expose file", call_type: "SELF_MADE", tool_name: "EXPOSE_FILE_ON_URL", payload: { file_path: "{generated_image}" } },
        { label: "Attach image", call_type: "Composio", tool_name: "SHOPIFY_CREATE_PRODUCT_IMAGE", payload: { image: { src: "{image_url}" }, product_id: "{product_id}" } }
      ]
    }
  ]
};

const canvas = document.getElementById("canvas") as HTMLDivElement;
const svg = document.getElementById("wires") as SVGSVGElement;

type NodeBBox = { x: number; y: number; w: number; h: number; el: HTMLElement };
let nodePositions: Record<string, NodeBBox> = {};

function createNode(id: string, opts: { title: string; subtitle?: string; type: "decision" | "action"; x: number; y: number }) {
  const el = document.createElement("div");
  el.className = `node node--${opts.type}`;
  el.style.left = `${opts.x}px`;
  el.style.top = `${opts.y}px`;
  el.innerHTML = `
    <div class="node__badge">
      ${opts.type === "decision" ? "Decision" : `<span class="provider"></span>&nbsp;Action`}
    </div>
    <div class="node__content">
      <h4 class="node__title">${opts.title}</h4>
      ${opts.subtitle ? `<div class="node__subtitle">${opts.subtitle}</div>` : ""}
    </div>
    <div class="port port--in" data-port="in"></div>
    <div class="port port--out" data-port="out"></div>
  `;
  el.dataset.nodeId = id;
  canvas.appendChild(el);
  const rect = el.getBoundingClientRect();
  const cRect = canvas.getBoundingClientRect();
  nodePositions[id] = {
    x: opts.x,
    y: opts.y,
    w: rect.width,
    h: rect.height,
    el
  };
}

function pathBetween(from: NodeBBox, to: NodeBBox, dx = 60): string {
  const x1 = from.x + from.w;              // right middle of from
  const y1 = from.y + from.h / 2;
  const x2 = to.x;                          // left middle of to
  const y2 = to.y + to.h / 2;
  const cx1 = x1 + dx;
  const cx2 = x2 - dx;
  return `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
}

function addWire(d: string) {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "rgba(150,161,179,.9)");
  p.setAttribute("stroke-width", "2");
  p.setAttribute("stroke-linecap", "round");
  svg.appendChild(p);
  return p;
}

function labelAt(mid: { x: number; y: number }, text: string) {
  const el = document.createElement("div");
  el.className = "branch-label";
  el.textContent = text;
  el.style.left = `${mid.x}px`;
  el.style.top = `${mid.y}px`;
  canvas.appendChild(el);
}

function bezierMidpoint(d: string): { x: number; y: number } {
  // Quick parser for "M x y C cx1 cy1, cx2 cy2, x y"
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
  const [x1, y1, cx1, cy1, cx2, cy2, x2, y2] = nums;
  // De Casteljau @ t=0.5
  const q0x = (x1 + cx1) / 2, q0y = (y1 + cy1) / 2;
  const q1x = (cx1 + cx2) / 2, q1y = (cy1 + cy2) / 2;
  const q2x = (cx2 + x2) / 2, q2y = (cy2 + y2) / 2;
  const r0x = (q0x + q1x) / 2, r0y = (q0y + q1y) / 2;
  const r1x = (q1x + q2x) / 2, r1y = (q1y + q2y) / 2;
  return { x: (r0x + r1x) / 2, y: (r0y + r1y) / 2 };
}

function render(plan: Plan) {
  canvas.querySelectorAll(".node, .branch-label").forEach(n => n.remove());
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  nodePositions = {};

  const originX = 140, originY = 160;
  let cursorY = originY;

  const columnWidth = 320;

  // Render steps top-level
  for (const step of plan.steps) {
    if ("split" in step) {
      const split = step.split;
      // Decision node
      createNode(split.id, { title: split.label, type: "decision", x: originX, y: cursorY });

      // Lay out branches in parallel columns to the right
      const branches = split.branches;
      const baseX = originX + columnWidth;
      const gapY = 140;

      branches.forEach((br, i) => {
        // First action in branch (you can expand to stacks)
        const first = br.steps[0] as ActionStep;
        const id = (first.action?.id) || `b${i}`;
        const y = cursorY + i * gapY;
        createNode(id, {
          title: first.action.label,
          subtitle: (first.action.provider || "").toUpperCase(),
          type: "action",
          x: baseX + i * 0, // all in same column; change if you want 3 columns
          y
        });

        const d = pathBetween(nodePositions[split.id], nodePositions[id], 70);
        const wire = addWire(d);
        const mid = bezierMidpoint(d);
        labelAt(mid, br.label);
      });

      // Advance cursor below the last branch
      cursorY += (split.branches.length - 1) * gapY + 200;
    }

    if ("sequential" in step) {
      let prevId: string | null = null;
      step.sequential.forEach((a, idx) => {
        const id = `seq_${idx}_${a.tool_name}`;
        createNode(id, {
          title: a.label || a.tool_name,
          subtitle: (a.call_type || "").toUpperCase(),
          type: "action",
          x: originX,
          y: cursorY + idx * 120
        });
        if (prevId) {
          const d = pathBetween(nodePositions[prevId], nodePositions[id], 60);
          addWire(d);
        }
        prevId = id;
      });
      cursorY += step.sequential.length * 120 + 40;
    }
  }

  // Resize SVG to content bounds
  const content = canvas.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${content.width} ${content.height}`);
}

document.addEventListener("DOMContentLoaded", () => {
  render(example);
  // Optional: make canvas responsive on resize
  window.addEventListener("resize", () => render(example));
});
