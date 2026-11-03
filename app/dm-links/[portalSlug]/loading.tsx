export default function DmLinksLoading() {
	return (
		<main
			className="flex min-h-dvh w-full justify-center bg-board"
			role="status"
			aria-label="Loading booking links…"
		>
			<div className="flex w-full max-w-[440px] flex-col gap-3 px-5 pt-10">
				<div className="h-3 w-40 animate-pulse rounded bg-board-raised" />
				<div className="h-6 w-32 animate-pulse rounded bg-board-raised" />
				<div className="mt-4 h-[42px] w-full animate-pulse rounded-[7px] bg-board-raised" />
			</div>
		</main>
	);
}
