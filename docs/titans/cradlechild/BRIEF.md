# CREATURE BRIEF: THE CRADLE CHILD / 요람의 아이

From WJ, 2026-10-15, built from his exchange about what the Cradle was preparing the universe for, three pieces of key art
and the assessment session's notes. Not built yet: this is the brief the build starts from.

**Key art** (mood and silhouette references, not sprites to trace):
- [keyart-tall.webp](keyart-tall.webp) and [keyart-wide.webp](keyart-wide.webp): the silhouette, the galaxy organs, the debris
  streams. Their burgundy is **not** the palette (see Palette).
- WJ's third, pale version (pearl-white body, rose flesh, gold core) **is the palette direction**. It still needs saving here
  as `keyart-pale.webp`.

**Name:** THE CRADLE CHILD / 요람의 아이 (*yoram-ui ai*, "the cradle's child"). WJ's call: the Cradle's Korean name is
태반체 ("placental body"). If the Child should rhyme with that, the option is **화신체** (*hwasinche*, "incarnation body").

**Essence:** incarnation

**Design compass:** Don't make it look powerful by moving its body more. Make it look powerful by making everything else
move because it did.

**Id (internal):** `cradlechild`

---

## Silhouette
- A tall, vertical, bilateral figure, the reverse of the Cradle's wide, tilted disc.
- At the top, a crown of pale bone arcs: a halo-like ring of scaffolding, never a face.
- Paired membrane lobes spread out to each side like wings or petals, each holding one embedded spiral galaxy.
- A central knot of pearl tissue with a glowing core: the "gestational singularity", where matter becomes anatomy.
- A long lower body that tapers into **three to five heavy strands**. Not dozens of thin ones: at pixel scale few heavy strands
  read, many thin ones turn to noise, and the motion spec (D28) wants slow, heavy sway.
- At 64 px it must read as: **crown + vertical body + paired wing-lobes with bright spots + trailing strands.** The Cradle reads as
  **wide disc + hanging knot + one cord.** Those two must never be confused.

## Size class
**Large**, about 240 px tall (the kit's large class, like the Cradle and the Last One). Not the 260–300 px the exchange
suggested: that is half the 640×360 screen, and D34 keeps titans at roughly 90–180 px with only a few large ones.

The wing-lobes may spread wider during moves, but its collision mass is the central body. The galaxies inside it and the
arena obeying it carry the scale, not its pixel count.

**Where its scale lives:** the galaxies inside its body, and loose matter all over the arena drifting toward it and
obeying it.

**Unfair at / open to:** it is unfair at controlling space with the arena's own matter. It is open to anyone who gets close
early, before it has gathered anything, or who catches it mid-gesture.

## Materials (outside to inside)
- sickly pearl-white developmental tissue, translucent at the edges (the dominant surface);
- pale rose flesh showing through it, with fine wine-red veins (thin lines only, never large burgundy areas);
- bone-white cosmological scaffolding: the crown arcs and the struts that hold the lobes open;
- membrane lobes, and inside each one a slowly turning galaxy (about 12–20 px across);
- nested chambers of smaller spirals down the torso ("organs still deciding what to be");
- at the centre, a warm stellar-gold core light: the gestational singularity.

It must look divine and obscene at the same time: clean enough to be mistaken for something holy, and fleshy enough up
close that it can't be.

## Palette mood: sickly divinity (WJ)
**Colours:**
- dominant: sickly pearl and bone-white, slightly yellowed and slightly green-grey (unwell, not clean);
- secondary: pale rose and flushed skin-pink flesh;
- thin wine-red veins and membrane edges;
- warm stellar gold at the core and the galaxy centres;
- in the galaxies: nebular violet and cold galactic blue.

**How it stays apart from the Cradle:** **value is inverted.** The Cradle is dark, burgundy-dominant, with cold light only where
it fails. The Child is pale-dominant with dark lines, and is the brightest body on the roster. Burgundy is a thin vein
colour here, never a fill. The palette check (`titan:check`) must pass against the Cradle with margin.

**Avoid:** the Last One's celadon iris and gold rim as a pair (gold only as light, not as a rim), the Witness's amethyst
(galaxy violet stays small, inside lobes), and the Supernova's orange.

## How it destroys matter: it INCORPORATES matter
It doesn't eat or burn. Matter it catches is taken into its body: a chunk drifts into a lobe, whitens to its pearl tissue
over about a second, and becomes part of it, until it is fired back out in a new, wrong shape (a calcified spike, a curved
blade of bone).

**What the Cradle fails at, the Child does perfectly.** The Cradle's false births are malformed. The Child's reassignments come
out finished and clean. That is the family resemblance and the horror at once.

**Its own wounds: incarnation reversal** (see Weakness). Its matter un-becomes when it breaks.

## The six buttons
The kit has six moves, and that limit is kept. Timing targets come from the titan guide (Strike 30–48 ticks, Crush
72–120, Ultimate 180–300).

| Button | Move | What happens |
|---|---|---|
| **Strike** | **Galactic Shear** | One lobe tightens around its galaxy and slings a curved band of stars across the arena: a sweeping, curved hitbox. **That galaxy stays dimmed and smeared for a few seconds and that lobe can't shear again until it recovers.** Its cooldown is visible on its body, with no UI. |
| **Crush** | **Incarnation Drop** | The lower body condenses around its mass and drives it down. Its one violent, physical move, and its close-range answer. Long recovery. |
| **Surge** | **Drift** | It moves like a storm system: slow to build, slow to stop, lobes trailing, inner galaxies lagging. Loose debris near its path is dragged along. |
| **Signature** | **Reassignment** (hold, then release) | Pulls nearby loose chunks into its lobes, **including matter torn off the opponent**. Held chunks whiten (incorporated) and ride its body, up to about six. Release fires them back out as wrong, finished structures. |
| **Ultimate** | **Make Use of Everything** | Every loose chunk in the arena, plus everything it holds, swings into a temporary lattice around the opponent (a clear ~1.5 s telegraph), then collapses onto them. The arena is left depleted afterwards. |
| **Guard** | **Gravitational Fold** | Projectiles and flying debris curve around it while it holds. Close blows still land. |

**The resource is the matter it holds, and you can see it.** No meter. Held chunks orbit and ride the lobes. A hit can knock a
held chunk loose, and then anyone can grab it (the Planet's capture ring included).

**Cut from the exchange, on purpose:** *Organ World* (a minion is a whole new system, which is clutter), a separate MATTER
meter, and grabbing literal planets (it uses the arena's real loose matter, which the engine already simulates).

**Engine fit:** the matter world already has a capture API (`MatterWorldEx`, proposal 142: the Planet's debris ring,
`launchChunk`). Reassignment builds on it. What's new is the incorporation step (recolour and attach), the release shapes and
the Fold's deflection. Online play needs `DMath` throughout (titan guide §4).

**Not a Planet copy:** the Planet *orbits* matter and throws it. The Child *absorbs* matter, changes it and grows. The
Child–Planet matchup becomes a fight over who owns the debris.

## Weakness: incarnation reversal
The Child holds its form only because every piece of incorporated matter keeps believing it is part of the Child. Damage
breaks that belief:
- chunks that break off fall away as **what they were before**: grey rock, stellar gas, dimming starlight. Not pearl flesh;
- a hit lobe loses tension and its galaxy drifts out of alignment;
- scaffold struts separate, and the core is more and more exposed;
- held chunks are shaken loose.

| State | Look |
|---|---|
| Healthy | everything has a purpose |
| Damaged | purpose is unravelling |
| Near death | the universe is falling back out of it |

The Cradle fails by growing wrong. The Child fails by un-becoming. Same family, opposite failure.

**Counterplay:** it is slow and starts every round with nothing gathered. Its big moves telegraph clearly. A fast titan
inside its reach, or one that steals its debris, has real openings.

## Sound
- far-off tectonic groans and gravitational creaks;
- glass harmonics and stellar radio noise;
- an impossibly low choral resonance;
- a wetness so faint it's worse when you notice it;
- gathering starts with tiny pebble sounds, and deeper layers join as more matter arrives;
- its biggest moves sound like a whole star system changing key, not an explosion.

Voice: kit voice with a very low pitch (about 30 Hz, "a mountain"), a lot of ring and some wet. Its own voice file
later if the kit voice can't do the choral layer.

## Lore
- **Main line:** "The Cradle did not carry the Child. It taught the universe how to survive its birth."
- **Short card line:** "It is never finished being born."
- **Mechanic line (card):** "Catches the arena's loose matter, makes it part of its body, and fires it back changed."
- **Story layer** (the site's STORY_LAYER, optional): life inside a galaxy it has incorporated. The sky becomes beautiful, the
  constellations drift wrong, and astronomers slowly understand they live inside tissue. *Cosmology slowly becoming anatomy.*

## Nods to the Cradle (WJ: related, but always distinguishable)
- **The cord.** The Child's lower body carries a healed umbilical scar where a cord once was. The Cradle has one immense
  cord. In the game the Cradle's cord can be cut and regrows wrong; the Child's was cut once and healed right.
- **The spokes.** The Cradle's calcified rib-spokes come back as the Child's bone-white scaffolding: the same material,
  finished.
- **The births.** The Cradle's False Birth expels malformed pseudo-organs. The Child's Reassignment expels perfect ones.
- **A shared moment** (optional, cheap): a CLASSIC story line (`src/ui/ladderStory.ts`), and a special intro line when the two
  meet.

**Never shared:** the silhouette (vertical vs wide), the dominant value (pale vs dark), the motion (the Child glides, the
Cradle billows and contracts).

## Homage notes
**Conceptual echoes:** sacred iconography (the halo and the seraph's radiating form), cosmic horror of incomprehensible
scale, embryology. Ancestor: the Cradle.

**It must stay its own creature, so avoid:**
- feathered wings or any angel shorthand beyond the radiating form;
- a face, eyes or a mouth (the crown may suggest a mask, but must never resolve into one);
- arms, hands or a human torso;
- fetus imagery (as with the Cradle);
- tentacle-monster shorthand: the strands are heavy and few.

**Its visual language:** vertical incarnation + crown of bone arcs + paired galaxy-bearing lobes + pearl tissue over rose flesh.

## Template
**blob** (a fresh painter). It shares nothing visual with the templates. Its *code* can learn from the Cradle's: the
lobes as sails on slow drives, rig regions for the lobes and strands, persistent damage per region.

## Build plan (gates WJ approves one by one, like the Cradle)
1. **Body:** palette, painter, still at 1×/3×/64 px, roster line-up next to the Cradle (must be distinguishable).
2. **Motion:** idle (galaxies turning, lobes changing tension), Drift, the slow-body rule (D28 tool in spec).
3. **Moves and signature:** the six buttons, Reassignment on the capture API, the Fold, the Shear's visible cooldown.
4. **Damage:** incarnation reversal (chunks revert as they detach, lobes lose alignment).
5. **Card, voice, hover clip, checks** (`titan:check`: 25–75 % win rate, AI uses every move), then WJ plays it and ships.

This is a Cradle-sized build: several sessions, not one.

## Open questions for WJ
1. Korean name: 요람의 아이 or 화신체?
2. A roster titan (tier 4, a heavy), or a boss later? (Recommended: a roster titan. The Mouth is already the planned final
   boss, D35.)
3. Save the pale key art here as `keyart-pale.webp`.

## Why it is strong
- **It pays off the Cradle's own card,** "it is not the child", so the lore grows inward instead of sideways.
- **Its verb, its anatomy and its failure are one idea:** matter forced into living form, and matter remembering what it
  was. That fits the game's core pitch (every pixel is matter) better than almost any titan.
- **Its scale is shown, not stated:** galaxies inside it, an arena that obeys it, at a readable large size.
