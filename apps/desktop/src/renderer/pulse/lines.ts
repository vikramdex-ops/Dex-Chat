// The day's line: short lines worth starting a working day with, mostly from engineers, architects,
// scientists and Indian thinkers. Attributions follow the usual sources; "attributed to" marks lines
// commonly credited to someone without a sure source. One line a day, the same for everyone.

export interface Line { text: string; by: string; role?: string; attributed?: boolean }

export const LINES: Line[] = [
  { text: 'The scientist describes what is; the engineer creates what never was.', by: 'Theodore von Kármán', role: 'Engineer' },
  { text: 'Simplicity is prerequisite for reliability.', by: 'Edsger W. Dijkstra', role: 'Computer scientist' },
  { text: 'Form follows function.', by: 'Louis Sullivan', role: 'Architect' },
  { text: 'Less is more.', by: 'Ludwig Mies van der Rohe', role: 'Architect' },
  { text: 'God is in the details.', by: 'Ludwig Mies van der Rohe', role: 'Architect', attributed: true },
  { text: 'The details are not the details. They make the design.', by: 'Charles Eames', role: 'Designer' },
  { text: 'Recognising the need is the primary condition for design.', by: 'Charles Eames', role: 'Designer' },
  { text: 'Quality is never an accident; it is always the result of intelligent effort.', by: 'John Ruskin', role: 'Writer' },
  { text: 'We shape our buildings; thereafter they shape us.', by: 'Winston Churchill' },
  { text: 'Design is not just what it looks like and feels like. Design is how it works.', by: 'Steve Jobs' },
  { text: 'Alone we can do so little; together we can do so much.', by: 'Helen Keller' },
  { text: 'Well begun is half done.', by: 'Aristotle', role: 'Philosopher' },
  { text: 'The beginning is the most important part of the work.', by: 'Plato', role: 'Philosopher' },
  { text: 'The best way to predict the future is to invent it.', by: 'Alan Kay', role: 'Computer scientist' },
  { text: 'If I have seen further, it is by standing on the shoulders of giants.', by: 'Isaac Newton', role: 'Physicist' },
  { text: 'Nothing in life is to be feared, it is only to be understood.', by: 'Marie Curie', role: 'Physicist and chemist' },
  { text: 'Imagination is more important than knowledge.', by: 'Albert Einstein', role: 'Physicist' },
  { text: 'Everything should be made as simple as possible, but not simpler.', by: 'Albert Einstein', role: 'Physicist', attributed: true },
  { text: 'It always seems impossible until it is done.', by: 'Nelson Mandela', attributed: true },
  { text: 'Arise, awake, and stop not till the goal is reached.', by: 'Swami Vivekananda' },
  { text: 'Strength is life, weakness is death.', by: 'Swami Vivekananda' },
  { text: 'Be the change you wish to see in the world.', by: 'Mahatma Gandhi', attributed: true },
  { text: 'Dream is not that which you see while sleeping; it is something that does not let you sleep.', by: 'A. P. J. Abdul Kalam', role: 'Scientist' },
  { text: 'If you want to shine like a sun, first burn like a sun.', by: 'A. P. J. Abdul Kalam', role: 'Scientist' },
  { text: 'Excellence is a continuous process and not an accident.', by: 'A. P. J. Abdul Kalam', role: 'Scientist' },
  { text: 'Learning gives creativity, creativity leads to thinking, thinking provides knowledge, knowledge makes you great.', by: 'A. P. J. Abdul Kalam', role: 'Scientist' },
  { text: 'Yoga is skill in action.', by: 'Bhagavad Gita', role: '2.50' },
  { text: 'You have a right to your work, but never to its fruits.', by: 'Bhagavad Gita', role: '2.47' },
  { text: 'Let noble thoughts come to us from every side.', by: 'Rig Veda', role: '1.89.1' },
  { text: 'You cannot cross the sea merely by standing and staring at the water.', by: 'Rabindranath Tagore', role: 'Poet' },
  { text: 'Where the mind is without fear and the head is held high, where knowledge is free.', by: 'Rabindranath Tagore', role: 'Poet' },
  { text: 'Engineering is the art of directing the great sources of power in nature for the use and convenience of man.', by: 'Thomas Tredgold', role: 'Engineer' },
  { text: 'Engineering is achieving function while avoiding failure.', by: 'Henry Petroski', role: 'Engineer' },
  { text: 'A house is a machine for living in.', by: 'Le Corbusier', role: 'Architect' },
  { text: 'Space and light and order. Those are the things that men need just as much as they need bread or a place to sleep.', by: 'Le Corbusier', role: 'Architect' },
  { text: 'Even a brick wants to be something.', by: 'Louis Kahn', role: 'Architect' },
  { text: 'A great building must begin with the unmeasurable, must go through measurable means when it is being designed, and in the end must be unmeasurable.', by: 'Louis Kahn', role: 'Architect' },
  { text: 'The physician can bury his mistakes, but the architect can only advise his client to plant vines.', by: 'Frank Lloyd Wright', role: 'Architect' },
  { text: 'Study nature, love nature, stay close to nature. It will never fail you.', by: 'Frank Lloyd Wright', role: 'Architect' },
  { text: 'Architecture should speak of its time and place, but yearn for timelessness.', by: 'Frank Gehry', role: 'Architect' },
  { text: 'A drawing is simply a line going for a walk.', by: 'Paul Klee', role: 'Painter' },
  { text: 'Have no fear of perfection; you will never reach it.', by: 'Salvador Dalí', role: 'Painter' },
  { text: 'Perfection is achieved not when there is nothing more to add, but when there is nothing left to take away.', by: 'Antoine de Saint-Exupéry', role: 'Writer and aviator' },
  { text: 'A goal without a plan is just a wish.', by: 'Antoine de Saint-Exupéry', role: 'Writer and aviator', attributed: true },
  { text: 'Plans are worthless, but planning is everything.', by: 'Dwight D. Eisenhower' },
  { text: 'Give me six hours to chop down a tree and I will spend the first four sharpening the axe.', by: 'Abraham Lincoln', attributed: true },
  { text: 'The secret of getting ahead is getting started.', by: 'Mark Twain', attributed: true },
  { text: 'Genius is one per cent inspiration and ninety-nine per cent perspiration.', by: 'Thomas Edison', role: 'Inventor' },
  { text: 'I have not failed. I have just found ten thousand ways that will not work.', by: 'Thomas Edison', role: 'Inventor', attributed: true },
  { text: 'Knowing is not enough; we must apply. Willing is not enough; we must do.', by: 'Johann Wolfgang von Goethe', role: 'Writer' },
  { text: 'Great things are done by a series of small things brought together.', by: 'Vincent van Gogh', role: 'Painter' },
  { text: 'Simplicity is the ultimate sophistication.', by: 'Leonardo da Vinci', attributed: true },
  { text: 'Learning never exhausts the mind.', by: 'Leonardo da Vinci' },
  { text: 'What I cannot create, I do not understand.', by: 'Richard Feynman', role: 'Physicist' },
  { text: 'For a successful technology, reality must take precedence over public relations, for nature cannot be fooled.', by: 'Richard Feynman', role: 'Physicist' },
  { text: 'An expert is a person who has made all the mistakes that can be made in a very narrow field.', by: 'Niels Bohr', role: 'Physicist' },
  { text: 'The most dangerous phrase in the language is: we have always done it this way.', by: 'Grace Hopper', role: 'Computer scientist' },
  { text: 'A ship in harbour is safe, but that is not what ships are built for.', by: 'John A. Shedd', role: 'Writer' },
  { text: 'Efficiency is doing things right; effectiveness is doing the right things.', by: 'Peter Drucker', role: 'Management thinker' },
  { text: 'None of us is as smart as all of us.', by: 'Ken Blanchard', role: 'Writer' },
  { text: 'Individually, we are one drop. Together, we are an ocean.', by: 'Ryunosuke Satoro', role: 'Poet' },
  { text: 'Mistakes are the portals of discovery.', by: 'James Joyce', role: 'Writer' },
  { text: 'There are no shortcuts to any place worth going.', by: 'Beverly Sills', role: 'Singer' },
  { text: 'Do what you can, with what you have, where you are.', by: 'Theodore Roosevelt' },
  { text: 'The way to get started is to quit talking and begin doing.', by: 'Walt Disney' },
  { text: 'In the midst of chaos, there is also opportunity.', by: 'Sun Tzu', role: 'Strategist' },
  { text: 'Opportunities multiply as they are seized.', by: 'Sun Tzu', role: 'Strategist' },
  { text: 'Courage is grace under pressure.', by: 'Ernest Hemingway', role: 'Writer' },
  { text: 'If everyone is moving forward together, then success takes care of itself.', by: 'Henry Ford', attributed: true },
  { text: 'Coming together is a beginning, staying together is progress, and working together is success.', by: 'Henry Ford', attributed: true },
  { text: 'Quality means doing it right when no one is looking.', by: 'Henry Ford', attributed: true },
  { text: 'The only way to do great work is to love what you do.', by: 'Steve Jobs' },
  { text: 'Good design is obvious. Great design is transparent.', by: 'Joe Sparano', role: 'Designer' },
  { text: 'If you think good design is expensive, you should look at the cost of bad design.', by: 'Ralf Speth', role: 'Engineer' },
  { text: 'Strive for progress, not perfection.', by: 'Proverb' },
  { text: 'Measure twice, cut once.', by: 'Workshop proverb' },
  { text: 'Many hands make light work.', by: 'Proverb' },
  { text: 'Slow and steady wins the race.', by: 'Aesop', role: 'Storyteller' },
  { text: 'Rome was not built in a day.', by: 'Proverb' },
  { text: 'Necessity is the mother of invention.', by: 'Proverb' },
  { text: 'Talent wins games, but teamwork and intelligence win championships.', by: 'Michael Jordan' },
  { text: 'Unity is strength. When there is teamwork and collaboration, wonderful things can be achieved.', by: 'Mattie Stepanek', role: 'Poet' },
  { text: 'Strive not to be a success, but rather to be of value.', by: 'Albert Einstein', role: 'Physicist', attributed: true },
  { text: 'Logic will get you from A to B. Imagination will take you everywhere.', by: 'Albert Einstein', role: 'Physicist', attributed: true },
  { text: 'Nature uses only the longest threads to weave her patterns.', by: 'Richard Feynman', role: 'Physicist' },
  { text: 'The future depends on what you do today.', by: 'Mahatma Gandhi', attributed: true },
  { text: 'Patience, persistence and perspiration make an unbeatable combination for success.', by: 'Napoleon Hill', role: 'Writer' },
  { text: 'Drawing is the honesty of the art.', by: 'Salvador Dalí', role: 'Painter' },
  { text: 'Teamwork is the ability to work together toward a common vision.', by: 'Andrew Carnegie', attributed: true },
  { text: 'It is not enough to be busy. The question is: what are we busy about?', by: 'Henry David Thoreau', role: 'Writer' },
  { text: 'Whatever the mind can conceive and believe, it can achieve.', by: 'Napoleon Hill', role: 'Writer' },
  { text: 'The best preparation for tomorrow is doing your best today.', by: 'H. Jackson Brown Jr.', role: 'Writer' },
  { text: 'Small deeds done are better than great deeds planned.', by: 'Peter Marshall', role: 'Preacher' },
  { text: 'An investment in knowledge pays the best interest.', by: 'Benjamin Franklin', attributed: true },
  { text: 'Well done is better than well said.', by: 'Benjamin Franklin' },
  { text: 'Ideas are easy. Implementation is hard.', by: 'Guy Kawasaki', role: 'Writer' },
  { text: 'A problem well stated is a problem half solved.', by: 'Charles Kettering', role: 'Engineer and inventor' },
  { text: 'The world hates change, yet it is the only thing that has brought progress.', by: 'Charles Kettering', role: 'Engineer and inventor' },
];

/** Day number in local time (days since 1 Jan 1970). */
export const dayNumber = (t = Date.now()) => { const d = new Date(t); return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400_000); };

/** A fixed shuffle so neighbouring days don't repeat an author, and every line comes round once a cycle. */
export function lineForDay(day: number, pool: Line[] = LINES): { line: Line; index: number } {
  const n = pool.length;
  // a step coprime with n walks every index once per cycle
  let step = Math.floor(n * 0.618) | 1;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  while (gcd(step, n) !== 1) step += 2;
  const index = (((day * step) % n) + n) % n;
  return { line: pool[index], index };
}

/** A small seeded random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
