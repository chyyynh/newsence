export class Client {
	async connect(): Promise<void> {}

	async query(): Promise<{ rows: unknown[]; rowCount: number }> {
		throw new Error('Unexpected pg query in workflow test. Mock the DB workflow step instead.');
	}
}
